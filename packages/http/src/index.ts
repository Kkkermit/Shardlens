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
  isAllowedEndpoint,
  type Logger,
  normaliseCustomId,
  type SaltPeriod,
  ShardlensClient,
  type ShardlensExporter,
  sanitiseCustomProps,
  uuidv7,
  type WireEvent,
} from '@shardlens/core';
import {
  describeRawInteraction,
  describeResponse,
  type RawInteraction,
  recordedCustomId,
  snowflake,
} from './interaction.js';
import { createTransports, type WaitUntilContext } from './transport.js';

export type { RawInteraction, RawInteractionData, RawOption, RawUser } from './interaction.js';
export type { WaitUntilContext } from './transport.js';

declare const __SDK_VERSION__: string | undefined;
const SDK_NAME = '@shardlens/http';
const SDK_VERSION: string = typeof __SDK_VERSION__ === 'string' ? __SDK_VERSION__ : '0.0.0-dev';
const DEADLINE_MS = 3_000;
/** The longest timer delay there is: a flush timer this slow never fires. */
const NEVER_MS = 2 ** 31 - 1;

export interface ShardlensHttpOptions {
  /** Your collector's URL. HTTPS, or HTTP to localhost only. Leave out with `apiKey` to use exporters only. */
  endpoint?: string | undefined;
  /** Ingest-only API key (`slk_ingest_…`). On Workers, keep it in a secret (`wrangler secret put`). */
  apiKey?: string | undefined;
  /** `'privacy'` (default) or `'audit'`; audit only takes effect when the collector is in audit mode too. */
  mode?: 'privacy' | 'audit' | undefined;
  /** Audit mode only: send each user's username and avatar with their ID. Default `true`; `false` records IDs only. */
  auditIncludeProfile?: boolean | undefined;
  /** Informational; the collector decides. Default `'month'`. */
  saltPeriod?: SaltPeriod | undefined;
  /**
   * Option names whose values may be recorded. Values of user, channel, role, mentionable and attachment options, and
   * any value holding a Discord ID, are never recorded; strings are cut to 100 characters, secrets redacted. Default
   * none.
   */
  captureOptionValues?: readonly string[] | undefined;
  /** Replaces the default custom-ID normaliser (numbers and IDs become `*`). */
  normaliseCustomId?: ((customId: string) => string) | undefined;
  /** Separates staging from production. Default `'production'`. */
  environment?: string | undefined;
  /** Your bot's version, to compare releases. */
  release?: string | undefined;
  /** A label for this deployment in SDK health, for example the Worker name. Default `'http'`. */
  instance?: string | undefined;
  /** Users who opted out earlier. Their events are dropped in-process. BigInt IDs from a database are accepted. */
  optedOut?: Iterable<string | bigint> | undefined;
  /** Sample rate per event type in (0, 1]. */
  sampleRate?: Readonly<Record<string, number>> | undefined;
  /** In-process metrics exporters. They get every event, never with a user. */
  exporters?: readonly ShardlensExporter[] | undefined;
  /** Print events instead of sending them. */
  dryRun?: boolean | undefined;
  /** Where SDK warnings go. Default `console`. */
  logger?: Logger | undefined;
  /** Override `fetch` (tests, proxies). */
  fetch?: typeof fetch | undefined;
}

/** Who a custom event is about. The user ID is hashed before it is sent. */
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
  /**
   * Records a custom event. Invalid events are dropped and counted, never thrown. On serverless runtimes pass the
   * request's `ctx` as `waitUntil`, or the event waits for the next interaction.
   */
  track<N extends CustomEventName>(
    name: N,
    props?: CustomEventProps<N>,
    context?: TrackContext,
    waitUntil?: WaitUntilContext,
  ): void;
  /** Drops this user's events from now on (for example after `/privacy opt-out`). Persist the choice yourself. */
  optOut(userId: string): void;
  /** Records this user's events again. */
  optIn(userId: string): void;
  isOptedOut(userId: string): boolean;
  /** Deletes everything the collector stored about a user. Never throws. */
  forgetUser(userId: string): Promise<{ erased: number } | undefined>;
  /** Waits for hashing to finish, then sends queued events. Use it inside `waitUntil` if you flush yourself. */
  flush(): Promise<void>;
  /** Sends what is queued and stops. Call it when a long-running server stops; Workers don't need it. */
  shutdown(options?: { timeoutMs?: number }): Promise<void>;
  /** The SDK's own health: queue depth, drops and internal errors. */
  stats(): ClientStats;
  /** Listens for the SDK's internal errors (tokens and request bodies removed). Returns a function that unsubscribes. */
  on(event: 'error', listener: (name: string, error: unknown) => void): () => void;
}

/** The first argument with a `waitUntil` method. Arguments can be anything, including objects whose getters throw. */
function findWaitUntil(args: readonly unknown[]): WaitUntilContext | undefined {
  try {
    for (const arg of args) {
      if (typeof arg === 'object' && arg !== null && typeof (arg as WaitUntilContext).waitUntil === 'function') {
        return arg as WaitUntilContext;
      }
    }
  } catch {
    // not one we can use
  }
  return undefined;
}

/** A `Response` whose JSON body can be read from a copy. Other bodies (files, streams) are left alone. */
function jsonResponse(value: unknown): Response | undefined {
  return typeof Response !== 'undefined' &&
    value instanceof Response &&
    !value.bodyUsed &&
    (value.headers.get('content-type') ?? '').includes('json')
    ? value
    : undefined;
}

/**
 * Creates Shardlens for an HTTP-interaction bot. Cheap to call at module scope: nothing runs (no timers, no network)
 * until the first interaction, which suits runtimes such as Cloudflare Workers that forbid I/O at startup.
 */
export function createShardlensHttp(options: ShardlensHttpOptions): ShardlensHttp {
  // Options come from Worker bindings and environment variables: anything malformed is ignored, never thrown into a
  // handler.
  return attach(typeof options === 'object' && options !== null ? options : {});
}

function attach(options: ShardlensHttpOptions): ShardlensHttp {
  const list = (value: unknown): unknown[] => {
    if (value === undefined || value === null || typeof value === 'string') return [];
    try {
      return typeof (value as Iterable<unknown>)[Symbol.iterator] === 'function'
        ? [...(value as Iterable<unknown>)]
        : [];
    } catch {
      return [];
    }
  };
  const describeOptions = {
    mode: options.mode ?? 'privacy',
    auditIncludeProfile: options.auditIncludeProfile ?? true,
    captureOptionValues: new Set(list(options.captureOptionValues).map(String)),
    normaliseCustomId: typeof options.normaliseCustomId === 'function' ? options.normaliseCustomId : normaliseCustomId,
  } as const;
  // BigInt IDs from a database client compare as strings, like Discord's.
  const optedOut = new Set(list(options.optedOut).map(String));
  const listeners = new Set<(name: string, error: unknown) => void>();
  const output = options.logger ?? console;
  // Under waitUntil a replaced client would repeat its predecessor's warnings; one of each is enough.
  const warned = new Set<string>();
  let dedupe = false;
  const logger: Logger = {
    warn: (message) => {
      if (dedupe && warned.has(message)) return;
      if (dedupe && warned.size < 100) warned.add(message);
      output.warn(message);
    },
    info: (message) => output.info?.(message),
  };

  const build = (withoutTimer: boolean): ShardlensClient => {
    dedupe = withoutTimer;
    let client: ShardlensClient;
    try {
      client = new ShardlensClient({
        endpoint: options.endpoint,
        apiKey: options.apiKey,
        exporters: options.exporters,
        sdk: { name: SDK_NAME, version: SDK_VERSION },
        mode: describeOptions.mode,
        source: () => ({ shards: [], instance: String(options.instance ?? 'http').slice(0, 128) }),
        logger,
        // Under waitUntil every request sends its own events; a timer would start a flush that dies with its request.
        ...(withoutTimer ? { flushIntervalMs: NEVER_MS } : {}),
        ...(options.environment !== undefined ? { environment: options.environment } : {}),
        ...(options.release !== undefined ? { release: options.release } : {}),
        ...(options.sampleRate !== undefined ? { sampleRate: options.sampleRate } : {}),
        ...(options.dryRun !== undefined ? { dryRun: options.dryRun } : {}),
        ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
      });
    } catch (error) {
      // Built once either way: retried on every interaction, a failing constructor would fail every interaction too.
      try {
        output.warn(`Shardlens: could not start (${errorClass(error)}); nothing is recorded.`);
      } catch {
        // a broken logger must not break the SDK
      }
      client = new ShardlensClient({ sdk: { name: SDK_NAME, version: SDK_VERSION }, logger: { warn: () => undefined } });
      client.count('init', error);
    }
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
  // Without a collector, a new client couldn't send either.
  const sends =
    options.dryRun === true || (typeof options.apiKey === 'string' && isAllowedEndpoint(String(options.endpoint)));
  const transports = createTransports(build, sends);

  /** Queues one interaction. `result` is what the handler returned, or its JSON body when it returned a `Response`. */
  const queue = (
    client: ShardlensClient,
    described: NonNullable<ReturnType<typeof describeRawInteraction>>,
    timing: { started: number; finished: number },
    outcome: { result?: unknown; error?: unknown },
  ) => {
    const { fields, userId } = described;
    const ackMs = Math.max(0, Math.round(timing.finished - fields.ts));
    const threw = 'error' in outcome;
    const { modalCustomId, ...response } = threw ? {} : describeResponse(outcome.result);
    const event = compact({
      ...fields,
      // A command answered with a modal carries the modal's ID, which links it to the later submission.
      customId:
        fields.customId ?? (modalCustomId === undefined ? undefined : recordedCustomId(modalCustomId, describeOptions)),
      outcome: threw ? 'error' : ackMs > DEADLINE_MS ? 'timeout' : 'ok',
      ackMs: threw ? undefined : ackMs,
      ...response,
      errorClass: threw ? errorClass(outcome.error) : undefined,
      errorCode: threw ? errorCode(outcome.error) : undefined,
      handlerMs: Math.max(0, Math.round(timing.finished - timing.started)),
    });
    client.enqueueWithUser(userId, fields.ts, 3, (user) => ({ ...event, user }) as unknown as WireEvent);
  };

  /** Records a handled interaction. Never throws. */
  const observe = (
    interaction: RawInteraction,
    ctx: WaitUntilContext | undefined,
    timing: { started: number; finished: number },
    outcome: { result?: unknown; error?: unknown },
  ) => {
    try {
      const described = describeRawInteraction(interaction, describeOptions);
      if (!described || optedOut.has(described.userId)) return;
      const response = 'error' in outcome ? undefined : jsonResponse(outcome.result);
      // Read from a copy, after the response has gone out.
      const body = response
        ?.clone()
        .json()
        .catch(() => undefined);
      const record = async (client: ShardlensClient) => {
        const result = body ? await body : outcome.result;
        queue(client, described, timing, 'error' in outcome ? outcome : { result });
      };
      if (ctx) transports.inRequest(ctx, record);
      else if (body) record(transports.current()).catch((error: unknown) => transports.count('record', error));
      else queue(transports.current(), described, timing, outcome);
    } catch (error) {
      transports.count('record', error);
    }
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
          observe(interaction, ctx, { started, finished: Date.now() }, { error });
          throw error;
        }
        observe(interaction, ctx, { started, finished: Date.now() }, { result });
        return result;
      };
    },

    track(name, props, context, waitUntil) {
      try {
        const clean = sanitiseCustomProps(props);
        if (typeof name !== 'string' || !CUSTOM_EVENT_NAME.test(name) || !clean) {
          transports.count('track_invalid');
          return;
        }
        // BigInt IDs from a database are accepted, as for `optedOut`.
        const given: unknown = context?.userId;
        const userId = (typeof given === 'string' || typeof given === 'bigint') && given !== '' ? String(given) : undefined;
        if (userId && optedOut.has(userId)) return;
        const guild = snowflake(context?.guildId);
        // Stamped now, not when the user hash is ready: that can be much later if the collector is unreachable.
        const ts = Date.now();
        const id = uuidv7(ts);
        const build = (user?: string) =>
          compact({ id, ts, type: 'custom', name, props: clean, user, guild }) as WireEvent;
        const record = (client: ShardlensClient) => {
          if (userId) client.enqueueWithUser(userId, ts, 2, (user) => build(user));
          else client.enqueue(build(), 2);
        };
        const ctx = findWaitUntil([waitUntil]);
        if (ctx) transports.inRequest(ctx, record);
        else record(transports.current());
      } catch (error) {
        transports.count('track', error);
      }
    },

    optOut: (userId) => void optedOut.add(String(userId)),
    optIn: (userId) => void optedOut.delete(String(userId)),
    isOptedOut: (userId) => optedOut.has(String(userId)),
    forgetUser: (userId) =>
      transports
        .using((client) => client.forgetUser(userId))
        .catch((error: unknown) => {
          transports.count('erase', error);
          return undefined;
        }),
    flush: () => transports.flush(),
    shutdown: async (shutdownOptions) => {
      if (!transports.started()) return;
      const client = transports.current();
      await client.idle(shutdownOptions?.timeoutMs);
      await client.shutdown(shutdownOptions);
    },
    stats: () => transports.current().stats(),
    on(event, listener) {
      if (event !== 'error') return () => undefined;
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
