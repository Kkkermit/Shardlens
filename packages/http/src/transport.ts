import type { ShardlensClient } from '@shardlens/core';

/** Anything with `waitUntil`, such as a Cloudflare Workers `ExecutionContext`. */
export interface WaitUntilContext {
  /** Keeps the runtime running until `promise` settles, after the response has been sent. */
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * One transport client. Under `waitUntil` (Cloudflare Workers, and serverless runtimes like it) whatever a request
 * starts dies with that request: a timer it set never fires, and a promise it created never settles, also for a later
 * request awaiting it. A client started by a request that has ended may never get its settings, never ask for a new
 * period's salt, or be stuck behind a flush that never ends. So once a `waitUntil` has been seen, clients run without a
 * flush timer (each request sends its own events), and a client that can't hash events for now, or whose flush failed
 * that way, is replaced by the request that needs it, unless the call that created it is still running.
 *
 * Long-running servers (Node, Bun, Deno) don't pass `waitUntil`, and keep one client and its timers.
 */
interface Transport {
  client: ShardlensClient;
  /** The call that created it is still running, so the settings request it started may still be answered. */
  starting: boolean;
  /** A flush was rejected, which only a promise left behind by an ended request does: it can't send again. */
  broken: boolean;
}

/** While the collector stays unreachable, replacements back off from 1 second to a minute. */
const REPLACE_MIN_MS = 1_000;
const REPLACE_MAX_MS = 60_000;
/** A flush another request started may end before this request's events were queued: try again, a few times. */
const MAX_FLUSHES = 3;
/** Hashed only to ask whether the client has a salt for now; never sent. */
const PROBE_USER = '0';

export interface Transports {
  /** The client for calls outside a `waitUntil`. Created on first use. */
  current(): ShardlensClient;
  /** Whether a client exists yet (nothing runs until the first event). */
  started(): boolean;
  /** Runs `work` inside `ctx.waitUntil` with a client able to send, then sends what it queued. Never throws. */
  inRequest(ctx: WaitUntilContext, work: (client: ShardlensClient) => void | Promise<void>): void;
  /** Runs `work` with a client able to send. The caller's request stays alive while it awaits this. */
  using<T>(work: (client: ShardlensClient) => Promise<T>): Promise<T>;
  /** Waits for hashing, then sends what is queued. Never throws. */
  flush(): Promise<void>;
  /** Counts an SDK failure, from inside a catch block where nothing may throw again. */
  count(name: string, error?: unknown): void;
}

/**
 * @param build - creates a client; `serverless` turns its flush timer off.
 * @param replaceable - false when a client could never send (no collector configured), so a new one wouldn't either.
 */
export function createTransports(build: (serverless: boolean) => ShardlensClient, replaceable: boolean): Transports {
  let transport: Transport | undefined;
  let serverless = false;
  let replaceDelay = REPLACE_MIN_MS;
  let replaceAt = 0;

  const created = (starting: boolean): Transport => {
    transport = { client: build(serverless), starting, broken: false };
    return transport;
  };
  const current = () => (transport ?? created(false)).client;
  const count = (name: string, error?: unknown) => {
    try {
      current().count(name, error);
    } catch {
      // nothing left to report to
    }
  };
  const canSend = async (t: Transport) => !t.broken && (await t.client.hashUser(PROBE_USER)) !== undefined;

  async function using<T>(work: (t: Transport) => Promise<T>): Promise<T> {
    let mine: Transport | undefined;
    let t: Transport;
    if (transport) t = transport;
    else t = mine = created(true);
    try {
      await t.client.idle();
      if (serverless && replaceable && !t.starting && Date.now() >= replaceAt && !(await canSend(t))) {
        if (transport !== t) {
          // Another request replaced it meanwhile.
          t = transport ?? t;
        } else {
          const old = t;
          t = mine = created(true);
          // Sends what the old client can still send; its timers, if any, stop.
          await Promise.all([old.client.shutdown({ timeoutMs: 1_000 }).catch(() => undefined), t.client.idle()]);
          if (await canSend(t)) replaceDelay = REPLACE_MIN_MS;
          else {
            replaceAt = Date.now() + replaceDelay;
            replaceDelay = Math.min(REPLACE_MAX_MS, replaceDelay * 2);
          }
        }
        await t.client.idle();
      }
      return await work(t);
    } finally {
      if (mine) mine.starting = false;
    }
  }

  const send = async (t: Transport) => {
    await t.client.idle();
    for (let i = 0; i < MAX_FLUSHES; i++) {
      try {
        await t.client.flush();
      } catch (error) {
        t.broken = true;
        t.client.count('flush', error);
        return;
      }
      if (t.client.stats().queueDepth === 0) return;
    }
  };

  return {
    current,
    started: () => transport !== undefined,
    inRequest(ctx, work) {
      serverless = true;
      const task = using(async (t) => {
        await work(t.client);
        await send(t);
      }).catch((error: unknown) => count('flush', error));
      try {
        ctx.waitUntil(task);
      } catch (error) {
        count('wait_until', error);
      }
    },
    using: (work) => using((t) => work(t.client)),
    flush: () => using(send).catch((error: unknown) => count('flush', error)),
    count,
  };
}
