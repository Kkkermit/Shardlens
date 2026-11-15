/**
 * `@shardlens/http`: Shardlens for Discord bots that receive interactions over HTTP (an Interactions Endpoint URL)
 * instead of the gateway: Cloudflare Workers, Deno, Bun, or Node with `@discordjs/core`. Web-standard APIs only.
 *
 * @packageDocumentation
 */
import {
  type ClientStats,
  CUSTOM_EVENT_NAME,
  type CustomEventName,
  type CustomEventProps,
  compact,
  errorClass,
  errorCode,
  type Logger,
  normaliseCustomId,
  type SaltPeriod,
  ShardlensClient,
  type ShardlensExporter,
  sanitiseCustomProps,
  uuidv7,
  type WireEvent,
} from '@shardlens/core';
import { describeRawInteraction, describeResponse, type RawInteraction } from './interaction.js';

export type { RawInteraction, RawInteractionData, RawOption, RawUser } from './interaction.js';

declare const __SDK_VERSION__: string | undefined;
const SDK_NAME = '@shardlens/http';
const SDK_VERSION: string = typeof __SDK_VERSION__ === 'string' ? __SDK_VERSION__ : '0.0.0-dev';
const DEADLINE_MS = 3_000;

export interface ShardlensHttpOptions {
  /** Your collector's URL. HTTPS, or HTTP to localhost only. Leave out with `apiKey` to use exporters only. */
  endpoint?: string | undefined;
  /** Ingest-only API key (`slk_ingest_…`). */
  apiKey?: string | undefined;
  /** `'privacy'` (default) or `'audit'`; audit only takes effect when the collector is in audit mode too. */
  mode?: 'privacy' | 'audit' | undefined;
  /** Audit mode only: send each user's username and avatar with their ID. Default `true`; `false` records IDs only. */
  auditIncludeProfile?: boolean | undefined;
  /** Informational; the collector decides. Default `'month'`. */
  saltPeriod?: SaltPeriod | undefined;
  /** Option names whose values may be recorded (truncated to 100 characters, secrets redacted). Default none. */
  captureOptionValues?: readonly string[] | undefined;
  /** Replaces the default custom-ID normaliser. */
  normaliseCustomId?: ((customId: string) => string) | undefined;
  /** Separates staging from production. Default `'production'`. */
  environment?: string | undefined;
  release?: string | undefined;
  /** A label for this deployment in SDK health, for example the Worker name. Default `'http'`. */
  instance?: string | undefined;
  /** Users who opted out earlier. Their events are dropped in-process. */
  optedOut?: Iterable<string> | undefined;
  /** Sample rate per event type in (0, 1]. */
  sampleRate?: Readonly<Record<string, number>> | undefined;
  exporters?: readonly ShardlensExporter[] | undefined;
  dryRun?: boolean | undefined;
  logger?: Logger | undefined;
  /** Override `fetch` (tests, proxies). */
  fetch?: typeof fetch | undefined;
}

/** Anything with `waitUntil`, such as a Cloudflare Workers `ExecutionContext`. */
export interface WaitUntilContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface TrackContext {
  userId?: string | undefined;
  guildId?: string | null | undefined;
}

export interface ShardlensHttp {
  /**
   * Wraps the function that answers an interaction. The wrapped function records the interaction, how long your
   * response took against Discord's 3-second deadline, and any error (re-thrown unchanged). Return the interaction
   * response body (or a `Response`) from your handler as usual.
   *
   * If any argument has a `waitUntil` method (a Workers `ExecutionContext`, for example), events are sent through it
   * after your response, so the runtime doesn't stop before they leave. PING interactions are not recorded.
   */
  wrapInteractionHandler<I extends RawInteraction, A extends unknown[], R>(
    handler: (interaction: I, ...args: A) => R | Promise<R>,
  ): (interaction: I, ...args: A) => Promise<Awaited<R>>;
  /** Records a custom event. Invalid events are dropped and counted, never thrown. */
  track<N extends CustomEventName>(
    name: N,
    props?: CustomEventProps<N>,
    context?: TrackContext,
    waitUntil?: WaitUntilContext,
  ): void;
  optOut(userId: string): void;
  optIn(userId: string): void;
  isOptedOut(userId: string): boolean;
  /** Deletes everything the collector stored about a user. Never throws. */
  forgetUser(userId: string): Promise<{ erased: number } | undefined>;
  /** Waits for hashing to finish, then sends queued events. Use it inside `waitUntil` if you flush yourself. */
  flush(): Promise<void>;
  shutdown(options?: { timeoutMs?: number }): Promise<void>;
  stats(): ClientStats;
  on(event: 'error', listener: (name: string, error: unknown) => void): () => void;
}

function findWaitUntil(args: readonly unknown[]): WaitUntilContext | undefined {
  for (const arg of args) {
    if (typeof arg === 'object' && arg !== null && typeof (arg as WaitUntilContext).waitUntil === 'function') {
      return arg as WaitUntilContext;
    }
  }
  return undefined;
}

/**
 * Creates Shardlens for an HTTP-interaction bot. Cheap to call at module scope: nothing runs (no timers, no network)
 * until the first interaction, which suits runtimes such as Cloudflare Workers that forbid I/O at startup.
 */
export function createShardlensHttp(options: ShardlensHttpOptions): ShardlensHttp {
  const describeOptions = {
    mode: options.mode ?? 'privacy',
    auditIncludeProfile: options.auditIncludeProfile ?? true,
    captureOptionValues: new Set(options.captureOptionValues ?? []),
    normaliseCustomId: options.normaliseCustomId ?? normaliseCustomId,
  } as const;
  const optedOut = new Set(options.optedOut ?? []);
  const listeners = new Set<(name: string, error: unknown) => void>();
  let client: ShardlensClient | undefined;

  const transport = (): ShardlensClient => {
    if (client) return client;
    client = new ShardlensClient({
      endpoint: options.endpoint,
      apiKey: options.apiKey,
      exporters: options.exporters,
      sdk: { name: SDK_NAME, version: SDK_VERSION },
      mode: describeOptions.mode,
      source: () => ({ shards: [], instance: (options.instance ?? 'http').slice(0, 128) }),
      ...(options.environment !== undefined ? { environment: options.environment } : {}),
      ...(options.release !== undefined ? { release: options.release } : {}),
      ...(options.sampleRate !== undefined ? { sampleRate: options.sampleRate } : {}),
      ...(options.dryRun !== undefined ? { dryRun: options.dryRun } : {}),
      ...(options.logger !== undefined ? { logger: options.logger } : {}),
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    });
    // One forwarder for every listener, so one added before the client existed can still be removed later.
    client.on('error', (name, error) => {
      for (const listener of listeners) {
        try {
          listener(name, error);
        } catch {
          // a broken listener must not break the SDK
        }
      }
    });
    return client;
  };

  const flush = async () => {
    const c = transport();
    await c.idle();
    await c.flush();
  };
  const sendLater = (ctx: WaitUntilContext | undefined) => {
    const work = flush().catch((error: unknown) => transport().count('flush', error));
    try {
      ctx?.waitUntil(work);
    } catch (error) {
      transport().count('wait_until', error);
    }
  };

  const record = (
    interaction: RawInteraction,
    started: number,
    finished: number,
    outcome: { body?: unknown; error?: unknown },
  ) => {
    const described = describeRawInteraction(interaction, describeOptions);
    if (!described) return;
    const { fields, userId } = described;
    if (userId && optedOut.has(userId)) return;
    const ackMs = Math.max(0, Math.round(finished - fields.ts));
    const failed = 'error' in outcome;
    const event = compact({
      ...fields,
      outcome: failed ? 'error' : ackMs > DEADLINE_MS ? 'timeout' : 'ok',
      ackMs: failed ? undefined : ackMs,
      ...(failed ? {} : describeResponse(outcome.body)),
      errorClass: failed ? errorClass(outcome.error) : undefined,
      errorCode: failed ? errorCode(outcome.error) : undefined,
      handlerMs: Math.max(0, Math.round(finished - started)),
    });
    const c = transport();
    if (userId) c.enqueueWithUser(userId, fields.ts, 3, (user) => ({ ...event, user }) as unknown as WireEvent);
    else c.enqueue(event as unknown as WireEvent, 3);
  };

  return {
    wrapInteractionHandler<I extends RawInteraction, A extends unknown[], R>(
      handler: (interaction: I, ...args: A) => R | Promise<R>,
    ) {
      return async (interaction: I, ...args: A): Promise<Awaited<R>> => {
        const ctx = findWaitUntil(args);
        const started = Date.now();
        let result: Awaited<R>;
        try {
          result = await handler(interaction, ...args);
        } catch (error) {
          try {
            record(interaction, started, Date.now(), { error });
            sendLater(ctx);
          } catch (inner) {
            transport().count('record', inner);
          }
          throw error;
        }
        const finished = Date.now();
        try {
          if (typeof Response !== 'undefined' && result instanceof Response) {
            // Read the body from a copy, after the response has gone out.
            const copy = result.clone();
            const later = copy
              .json()
              .catch(() => undefined)
              .then((body) => {
                record(interaction, started, finished, { body });
                return flush();
              })
              .catch((error: unknown) => transport().count('record', error));
            ctx?.waitUntil(later);
          } else {
            record(interaction, started, finished, { body: result });
            sendLater(ctx);
          }
        } catch (error) {
          transport().count('record', error);
        }
        return result;
      };
    },

    track(name, props, context, waitUntil) {
      try {
        const c = transport();
        const clean = sanitiseCustomProps(props);
        if (typeof name !== 'string' || !CUSTOM_EVENT_NAME.test(name) || !clean) {
          c.count('track_invalid');
          return;
        }
        if (context?.userId && optedOut.has(context.userId)) return;
        const guild = context?.guildId && /^\d{17,20}$/.test(context.guildId) ? context.guildId : undefined;
        // Stamped now, not when the user hash is ready: that can be much later if the collector is unreachable.
        const ts = Date.now();
        const id = uuidv7(ts);
        const build = (user?: string) =>
          compact({ id, ts, type: 'custom', name, props: clean, user, guild }) as WireEvent;
        if (context?.userId) c.enqueueWithUser(context.userId, ts, 2, (user) => build(user));
        else c.enqueue(build(), 2);
        if (waitUntil) sendLater(waitUntil);
      } catch (error) {
        transport().count('track', error);
      }
    },

    optOut: (userId) => void optedOut.add(userId),
    optIn: (userId) => void optedOut.delete(userId),
    isOptedOut: (userId) => optedOut.has(userId),
    forgetUser: async (userId) => {
      const c = transport();
      await c.idle();
      return c.forgetUser(userId);
    },
    flush,
    shutdown: async (shutdownOptions) => {
      if (!client) return;
      await client.idle(shutdownOptions?.timeoutMs);
      await client.shutdown(shutdownOptions);
    },
    stats: () => transport().stats(),
    on(event, listener) {
      if (event !== 'error') return () => undefined;
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
