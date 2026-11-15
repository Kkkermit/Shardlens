/**
 * `@shardlens/discordjs`: privacy-first product analytics and bot health for discord.js, through public hooks only.
 *
 * @packageDocumentation
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import {
  type ClientStats,
  CUSTOM_EVENT_NAME,
  type CustomEventName,
  type CustomEventProps,
  compact,
  errorClass,
  errorCode,
  ShardlensClient,
  sanitiseCustomProps,
  uuidv7,
  type WireEvent,
} from '@shardlens/core';
import type { EventInput } from '@shardlens/schema';
import {
  type BaseInteraction,
  type Client,
  type Entitlement,
  Events,
  type Guild,
  type Interaction,
  type Message,
  type Subscription,
} from 'discord.js';
import { listenShardEvents, shardIds } from './gateway.js';
import {
  CountRefresher,
  guildAvailability,
  guildJoin,
  guildLeave,
  guildSnapshots,
  guildUpdate,
  ProfilePacer,
  shardSnapshot,
} from './guilds.js';
import { InteractionTracker } from './interactions.js';
import { describeMessageCommand, type MessageCommandInfo, type MessageCommandRun } from './message-commands.js';
import type { MetricGroup, ShardlensOptions } from './options.js';
import { installRestHooks, type RestHooks } from './rest.js';
import {
  appInfo,
  commandRegistry,
  defaultInstance,
  detectSource,
  gaugeWindow,
  ownsShardZero,
  totalShards,
} from './runtime.js';
import { FileSpool } from './spool.js';
import { LruMap, SDK_NAME, SDK_VERSION } from './util.js';

export type { ShardlensExporter } from '@shardlens/core';
export type { MessageCommandInfo, MessageCommandRun } from './message-commands.js';
export type { MetricGroup, ShardlensOptions } from './options.js';
export { createPrivacyCommand, type PrivacyCommand, type PrivacyCommandOptions } from './privacy-command.js';
export { normaliseRoute } from './util.js';

const GAUGE_INTERVAL_MS = 30_000;
const APP_INFO_INTERVAL_MS = 30 * 60_000;
const REGISTRY_INTERVAL_MS = 60 * 60_000;
const PROFILES_PER_TICK = 250;
/** `refreshGuildCounts`: one server every two seconds, at most 30 REST calls a minute. */
const COUNT_REFRESH_MS = 2_000;

/** Duck-typed so a second copy of discord.js in `node_modules` still counts as an interaction. */
function isInteraction(value: unknown): value is Interaction {
  const v = value as { id?: unknown; isRepliable?: unknown } | null | undefined;
  return typeof v?.id === 'string' && typeof v.isRepliable === 'function';
}

/** Optional context for a custom event. The user ID is hashed in-process before it is sent. */
export interface TrackContext {
  userId?: string | undefined;
  guildId?: string | null | undefined;
}

/** How a handler went, for {@link Shardlens.handlerFinished}. */
export interface HandlerResult {
  /** How long the handler ran, in milliseconds. Measured from `handlerStarted()` when left out. */
  durationMs?: number | undefined;
  /** What the handler threw, if anything. Only its class name and Discord error code are recorded. */
  error?: unknown;
}

/** SDK health, including interactions still waiting for a response. */
export interface ShardlensStats extends ClientStats {
  pendingInteractions: number;
}

export interface Shardlens {
  /**
   * Records a custom event. Names are lower snake case; properties are limited to 2 KB of strings, numbers, booleans
   * and nulls. Invalid events are dropped and counted, never thrown.
   */
  track<N extends CustomEventName>(name: N, props?: CustomEventProps<N>, context?: TrackContext): void;
  /**
   * Wraps an interaction handler to record its duration and failures. The handler's errors are re-thrown unchanged,
   * so your own error handling still runs.
   */
  wrap<A extends [BaseInteraction, ...unknown[]], R>(
    handler: (...args: A) => R | Promise<R>,
  ): (...args: A) => Promise<Awaited<R>>;
  /**
   * For frameworks that run handlers themselves and announce it (Sapphire's `chatInputCommandRun`, for example): call
   * when the handler starts. With {@link Shardlens.handlerFinished} it records what {@link Shardlens.wrap} would.
   */
  handlerStarted(interaction: BaseInteraction): void;
  /** Call when a handler started with {@link Shardlens.handlerStarted} has finished or thrown. */
  handlerFinished(interaction: BaseInteraction, result?: HandlerResult): void;
  /**
   * Records a command run from a message, such as a prefix command (`!ban @user`), after your bot's parser matched it.
   * Pass the command's own name, not what was typed: message content is never read. Counted with interactions on
   * the dashboard. Invalid runs are dropped and counted, never thrown.
   */
  trackMessageCommand(message: Message, run: MessageCommandRun): void;
  /**
   * Wraps a message command handler to record its duration and failures, like {@link Shardlens.wrap} does for
   * interactions. The handler's errors are re-thrown unchanged.
   */
  wrapMessageCommand<A extends [Message, ...unknown[]], R>(
    command: string | MessageCommandInfo,
    handler: (...args: A) => R | Promise<R>,
  ): (...args: A) => Promise<Awaited<R>>;
  /** Stops recording a user's interactions in this process (for example from a `/privacy optout` command). */
  optOut(userId: string): void;
  /** Reverses {@link Shardlens.optOut}. */
  optIn(userId: string): void;
  isOptedOut(userId: string): boolean;
  /**
   * Deletes everything the collector stored about a user (right to erasure). Does not opt them out of future
   * collection; call {@link Shardlens.optOut} as well if they asked for that. Never throws.
   */
  forgetUser(userId: string): Promise<{ erased: number } | undefined>;
  on(event: 'error', listener: (name: string, error: unknown) => void): () => void;
  flush(): Promise<void>;
  /**
   * Removes all hooks and flushes, giving up after `timeoutMs` (default 2,000). A second call, such as SIGTERM from a
   * shard manager after SIGINT from the terminal, waits for the same flush. The SDK never handles signals.
   */
  shutdown(options?: { timeoutMs?: number }): Promise<void>;
  stats(): ShardlensStats;
  readonly client: ShardlensClient;
}

/**
 * Attaches Shardlens to a discord.js client. Call it before `client.login()`. Only the `Guilds` intent is needed.
 * The SDK never throws into your bot: every failure is caught and counted.
 */
export function createShardlens(client: Client, options: ShardlensOptions): Shardlens {
  // Options are often built from environment variables and config files: anything malformed is ignored with a
  // warning, never thrown into the bot's startup.
  return attach(client, typeof options === 'object' && options !== null ? options : {});
}

function attach(client: Client, options: ShardlensOptions): Shardlens {
  const warned = new Set<string>();
  const warn = (key: string, message: string) => {
    if (warned.has(key)) return;
    warned.add(key);
    try {
      (options.logger ?? console).warn(message);
    } catch {
      // a broken logger must not break the SDK
    }
  };
  const list = (value: unknown, name: string): unknown[] => {
    if (value === undefined || value === null) return [];
    if (typeof value !== 'string' && typeof (value as Iterable<unknown>)[Symbol.iterator] === 'function') {
      try {
        return [...(value as Iterable<unknown>)];
      } catch {
        // falls through to the warning
      }
    }
    warn(name, `Shardlens: ${name} must be a list; it is ignored.`);
    return [];
  };
  const disabled = new Set(list(options.disable, 'disable') as MetricGroup[]);
  const mode = options.mode ?? 'privacy';
  const instance = defaultInstance();
  const spoolDir = typeof options.spool === 'string' ? options.spool : options.spool?.dir;
  if (options.spool !== undefined && typeof spoolDir !== 'string') {
    warn('spool', "Shardlens: spool must be { dir: './shardlens-spool' }; events are kept in memory only.");
  }

  const transport = new ShardlensClient<EventInput>({
    endpoint: options.endpoint,
    apiKey: options.apiKey,
    exporters: options.exporters,
    spool:
      typeof spoolDir === 'string'
        ? new FileSpool(spoolDir, typeof options.spool === 'object' ? options.spool.maxBytes : undefined)
        : undefined,
    sdk: { name: SDK_NAME, version: SDK_VERSION },
    mode,
    source: () => detectSource(client, instance),
    ...(options.environment !== undefined ? { environment: options.environment } : {}),
    ...(options.release !== undefined ? { release: options.release } : {}),
    ...(options.flushIntervalMs !== undefined ? { flushIntervalMs: options.flushIntervalMs } : {}),
    ...(options.maxBatchSize !== undefined ? { maxBatchSize: options.maxBatchSize } : {}),
    ...(options.maxQueueSize !== undefined ? { maxQueueSize: options.maxQueueSize } : {}),
    ...(options.sampleRate !== undefined ? { sampleRate: options.sampleRate } : {}),
    ...(options.dryRun !== undefined ? { dryRun: options.dryRun } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
  });

  const count = (name: string, error?: unknown) => transport.count(name, error);
  /** Every listener body runs through this: the SDK must never throw into the bot. */
  const safe =
    <A extends unknown[]>(name: string, fn: (...args: A) => void | Promise<void>) =>
    (...args: A): void => {
      try {
        const result = fn(...args);
        if (result instanceof Promise) result.catch((error: unknown) => count(name, error));
      } catch (error) {
        count(name, error);
      }
    };
  const enqueue = (event: EventInput, priority: 0 | 1 | 2 | 3) => transport.enqueue(event, priority);
  const shardCount = () => totalShards(client);

  // IDs loaded from a database may be BigInts (Prisma, for one): compared as strings, like Discord's.
  const optedOut = new Set(list(options.optedOut, 'optedOut').map(String));
  const tracker = disabled.has('interactions')
    ? undefined
    : new InteractionTracker({ client: transport, options: { ...options, mode }, count, shardCount, optedOut });

  const listeners: [string, (...args: never[]) => void][] = [];
  const listen = <A extends unknown[]>(event: string, name: string, fn: (...args: A) => void | Promise<void>) => {
    const handler = safe(name, fn);
    client.on(event, handler as (...args: unknown[]) => void);
    listeners.push([event, handler as unknown as (...args: never[]) => void]);
  };
  const timers: ReturnType<typeof setInterval>[] = [];
  let unlistenShards: (() => void) | undefined;
  const every = (ms: number, name: string, fn: () => void | Promise<void>) => {
    const t = setInterval(safe(name, fn), ms);
    t.unref?.();
    timers.push(t);
  };

  const notifyOptOut = (userId: string, optedOut: boolean) => {
    try {
      options.onOptOutChange?.(userId, optedOut);
    } catch (error) {
      count('onOptOutChange', error);
    }
  };

  if (tracker) {
    listen(Events.InteractionCreate, 'interactionCreate', (interaction: Interaction) => tracker.observe(interaction));
  }

  let restHooks: RestHooks | undefined;
  if (!disabled.has('rest') || tracker) {
    try {
      restHooks = installRestHooks(client, {
        tracker,
        enqueue: (event, priority) => {
          if (!disabled.has('rest') || event.type === 'interaction') enqueue(event, priority);
        },
        count,
        safe,
      });
    } catch (error) {
      count('installRest', error);
    }
  }

  const pacer = new ProfilePacer();
  let initialReady = false;
  if (!disabled.has('guilds')) {
    listen(Events.GuildCreate, 'guildCreate', (guild: Guild) => enqueue(guildJoin(guild), 3));
    listen(Events.GuildUpdate, 'guildUpdate', (_old: Guild, guild: Guild) => enqueue(guildUpdate(guild), 1));
    listen(Events.GuildDelete, 'guildDelete', (guild: Guild) => enqueue(guildLeave(guild.id), 3));
    // discord.js also announces every server as "available" while a shard starts up. Only a server this process saw
    // go down is an outage ending.
    const outages = new LruMap<string, true>(10_000);
    listen(Events.GuildUnavailable, 'guildUnavailable', (guild: Guild) => {
      outages.set(guild.id, true);
      enqueue(guildAvailability(guild, false), 2);
    });
    listen(Events.GuildAvailable, 'guildAvailable', (guild: Guild) => {
      if (outages.delete(guild.id)) enqueue(guildAvailability(guild, true), 2);
    });
    listen(
      Events.ApplicationCommandPermissionsUpdate,
      'commandPermissions',
      (data: { id: string; guildId: string; permissions: readonly unknown[] }) => {
        enqueue(
          {
            id: uuidv7(),
            ts: Date.now(),
            type: 'command_permissions',
            guild: data.guildId,
            command: data.id,
            overwrites: data.permissions.length,
          },
          2,
        );
      },
    );
  }

  const sendSnapshots = (shards: readonly number[]) => {
    if (disabled.has('guilds')) return;
    for (const event of guildSnapshots(client.guilds.cache.values(), shards, shardCount())) enqueue(event, 3);
  };

  if (!disabled.has('gateway')) {
    const shardEvent = (shard: number, state: string, extra: Record<string, number | undefined> = {}) =>
      enqueue(compact({ id: uuidv7(), ts: Date.now(), type: 'shard_state', shard, state, ...extra }) as EventInput, 2);
    // discord.js 14 emits these on the client, 15 on `client.ws`; gateway.ts picks the right one.
    unlistenShards = listenShardEvents(
      client,
      {
        ready: (shard, unavailableGuilds, guilds) => {
          shardEvent(shard, 'ready', { unavailableGuilds });
          if (!initialReady || disabled.has('guilds')) return;
          // A fresh session: Discord's list catches servers added and removed while the shard was away. The cache
          // still holds the removed ones, and on discord.js 15 doesn't have the added ones yet.
          if (guilds) enqueue(shardSnapshot(shard, guilds, shardCount()), 3);
          else sendSnapshots([shard]);
        },
        resumed: (shard, replayed) => shardEvent(shard, 'resumed', { replayed }),
        reconnecting: (shard) => shardEvent(shard, 'reconnecting'),
        disconnected: (shard, closeCode) => shardEvent(shard, 'disconnected', { closeCode }),
        error: (shard) => shardEvent(shard, 'error'),
      },
      safe,
    );
    listen(Events.Invalidated, 'invalidated', () => {
      for (const shard of shardIds(client)) shardEvent(shard, 'invalidated');
    });
  }

  if (!disabled.has('premium')) {
    const entitlement = (action: 'create' | 'update' | 'delete', e: Entitlement) => {
      const build = (user?: string): EventInput =>
        compact({
          id: uuidv7(),
          ts: Date.now(),
          type: 'entitlement' as const,
          action,
          sku: e.skuId,
          entitlementType: Number(e.type),
          owner: e.guildId ? ('guild' as const) : ('user' as const),
          user,
          guild: e.guildId ?? undefined,
          startsAt: e.startsTimestamp ?? null,
          endsAt: e.endsTimestamp ?? null,
        });
      if (e.userId) {
        if (!optedOut.has(e.userId)) transport.enqueueWithUser(e.userId, Date.now(), 2, (user) => build(user));
      } else enqueue(build(), 2);
    };
    listen(Events.EntitlementCreate, 'entitlementCreate', (e: Entitlement) => entitlement('create', e));
    listen(Events.EntitlementUpdate, 'entitlementUpdate', (_old: Entitlement | null, e: Entitlement) =>
      entitlement('update', e),
    );
    listen(Events.EntitlementDelete, 'entitlementDelete', (e: Entitlement) => entitlement('delete', e));

    const subscription = (action: 'create' | 'update' | 'delete', s: Subscription) => {
      if (optedOut.has(s.userId)) return;
      transport.enqueueWithUser(s.userId, Date.now(), 2, (user) => ({
        id: uuidv7(),
        ts: Date.now(),
        type: 'subscription',
        action,
        status: Number(s.status),
        skus: [...s.skuIds],
        user,
        periodStart: s.currentPeriodStartTimestamp,
        periodEnd: s.currentPeriodEndTimestamp,
      }));
    };
    listen(Events.SubscriptionCreate, 'subscriptionCreate', (s: Subscription) => subscription('create', s));
    listen(Events.SubscriptionUpdate, 'subscriptionUpdate', (_old: Subscription | null, s: Subscription) =>
      subscription('update', s),
    );
    listen(Events.SubscriptionDelete, 'subscriptionDelete', (s: Subscription) => subscription('delete', s));
  }

  const sendAppInfo = async () => {
    if (disabled.has('app') || !client.isReady() || !ownsShardZero(client)) return;
    enqueue(await appInfo(client), 2);
  };
  const sendRegistry = async () => {
    if (disabled.has('app') || !client.isReady() || !ownsShardZero(client)) return;
    enqueue(await commandRegistry(client), 2);
  };
  const onReady = safe('clientReady', async () => {
    if (initialReady) return;
    initialReady = true;
    // On its own, so a failure here doesn't also skip the app info and command list.
    try {
      sendSnapshots(detectSource(client, instance).shards);
      if (!disabled.has('guilds')) pacer.reset(client.guilds.cache.keys());
    } catch (error) {
      count('guildSnapshot', error);
    }
    await Promise.allSettled([
      sendAppInfo().catch((error: unknown) => count('appInfo', error)),
      sendRegistry().catch((error: unknown) => count('commandRegistry', error)),
    ]);
  });
  if (client.isReady()) onReady();
  else {
    client.once(Events.ClientReady, onReady);
    listeners.push([Events.ClientReady, onReady as (...args: never[]) => void]);
  }

  // The core client's flush interval and queue size, with the same fallbacks for values that aren't numbers.
  const flushIntervalMs = Number.isFinite(options.flushIntervalMs) ? (options.flushIntervalMs as number) : 5_000;
  const maxQueueSize = Number.isFinite(options.maxQueueSize) ? (options.maxQueueSize as number) : 10_000;
  every(Math.min(2 ** 31 - 1, Math.max(250, flushIntervalMs)), 'restWindow', () => {
    const window = restHooks?.drain();
    if (window && !disabled.has('rest')) enqueue(window, 1);
    const room = maxQueueSize / 2 - transport.stats().queueDepth;
    pacer.tick(Math.min(PROFILES_PER_TICK, room), (id) => {
      const guild = client.guilds.cache.get(id);
      if (guild) enqueue(guildUpdate(guild), 1);
    });
  });

  const loop = disabled.has('process') ? undefined : monitorEventLoopDelay({ resolution: 20 });
  loop?.enable();
  if (!disabled.has('process')) every(GAUGE_INTERVAL_MS, 'gauges', () => enqueue(gaugeWindow(client, loop), 0));
  if (options.refreshGuildCounts && !disabled.has('guilds')) {
    const refresher = new CountRefresher();
    let refreshing = false;
    every(COUNT_REFRESH_MS, 'refreshGuildCounts', async () => {
      // While Discord is slow, calls would pile up past the documented 30 a minute.
      if (!client.isReady() || refreshing) return;
      refreshing = true;
      try {
        const event = await refresher.next(client);
        if (event) enqueue(event, 2);
      } finally {
        refreshing = false;
      }
    });
  }
  every(APP_INFO_INTERVAL_MS, 'appInfo', sendAppInfo);
  every(REGISTRY_INTERVAL_MS, 'commandRegistry', sendRegistry);

  const trackMessageCommand = (message: Message, run: MessageCommandRun): void => {
    try {
      const userId = message.author.id;
      if (!tracker || optedOut.has(userId)) return;
      const event = describeMessageCommand(message, run, { ...options, mode }, shardCount());
      if (!event) {
        count('message_command_invalid');
        return;
      }
      transport.enqueueWithUser(userId, event.ts, 3, (user) => ({ ...event, user }));
    } catch (error) {
      count('trackMessageCommand', error);
    }
  };

  let stopping: Promise<void> | undefined;
  async function stop(opts: { timeoutMs?: number }): Promise<void> {
    try {
      for (const t of timers) clearInterval(t);
      for (const [event, handler] of listeners) client.off(event, handler as (...args: unknown[]) => void);
      unlistenShards?.();
      loop?.disable();
      tracker?.flushPending();
      const window = restHooks?.drain();
      if (window && !disabled.has('rest')) enqueue(window, 1);
      restHooks?.uninstall();
    } catch (error) {
      count('shutdown', error);
    }
    await transport.shutdown(opts);
  }

  return {
    client: transport as unknown as ShardlensClient<WireEvent>,

    track(name, props, context) {
      try {
        const clean = sanitiseCustomProps(props);
        if (typeof name !== 'string' || !CUSTOM_EVENT_NAME.test(name) || !clean) {
          count('track_invalid');
          return;
        }
        if (context?.userId && optedOut.has(context.userId)) return;
        // Stamped now, not when the user hash is ready: that can be much later if the collector is unreachable.
        const ts = Date.now();
        const id = uuidv7(ts);
        const build = (user?: string): EventInput =>
          compact({
            id,
            ts,
            type: 'custom' as const,
            name,
            props: clean,
            user,
            guild: context?.guildId && /^\d{17,20}$/.test(context.guildId) ? context.guildId : undefined,
          });
        if (context?.userId) transport.enqueueWithUser(context.userId, ts, 2, (user) => build(user));
        else enqueue(build(), 2);
      } catch (error) {
        count('track', error);
      }
    },

    wrap<A extends [BaseInteraction, ...unknown[]], R>(handler: (...args: A) => R | Promise<R>) {
      return async (...args: A): Promise<Awaited<R>> => {
        const started = performance.now();
        // A handler shared by slash and prefix commands may get something else first; that is not recorded here.
        let interaction: Interaction | undefined;
        try {
          interaction = isInteraction(args[0]) ? args[0] : undefined;
          if (interaction) tracker?.handlerStarted(interaction);
        } catch (error) {
          count('wrap', error);
        }
        try {
          const result = (await handler(...args)) as Awaited<R>;
          try {
            if (interaction) tracker?.handlerFinished(interaction, performance.now() - started);
          } catch (error) {
            count('wrap', error);
          }
          return result;
        } catch (error) {
          try {
            const code = errorCode(error);
            if (interaction) {
              tracker?.handlerFinished(interaction, performance.now() - started, {
                errorClass: errorClass(error),
                ...(code !== undefined ? { errorCode: code } : {}),
              });
            }
          } catch (inner) {
            count('wrap', inner);
          }
          throw error;
        }
      };
    },

    handlerStarted(interaction) {
      try {
        if (isInteraction(interaction)) tracker?.handlerStarted(interaction);
      } catch (error) {
        count('handlerStarted', error);
      }
    },

    handlerFinished(interaction, result = {}) {
      try {
        if (!isInteraction(interaction)) return;
        const ms = result.durationMs;
        const error = result.error;
        const code = error === undefined ? undefined : errorCode(error);
        tracker?.handlerFinished(
          interaction,
          typeof ms === 'number' && Number.isFinite(ms) ? Math.max(0, ms) : undefined,
          error === undefined
            ? undefined
            : { errorClass: errorClass(error), ...(code !== undefined ? { errorCode: code } : {}) },
        );
      } catch (error) {
        count('handlerFinished', error);
      }
    },

    trackMessageCommand,

    wrapMessageCommand<A extends [Message, ...unknown[]], R>(
      command: string | MessageCommandInfo,
      handler: (...args: A) => R | Promise<R>,
    ) {
      const info: MessageCommandInfo = typeof command === 'string' ? { command } : command;
      return async (...args: A): Promise<Awaited<R>> => {
        const started = performance.now();
        try {
          const result = (await handler(...args)) as Awaited<R>;
          trackMessageCommand(args[0], { ...info, durationMs: performance.now() - started });
          return result;
        } catch (error) {
          trackMessageCommand(args[0], { ...info, durationMs: performance.now() - started, error });
          throw error;
        }
      };
    },

    optOut(userId) {
      const id = String(userId);
      if (optedOut.has(id)) return;
      optedOut.add(id);
      tracker?.dropPending(id);
      notifyOptOut(id, true);
    },

    optIn(userId) {
      const id = String(userId);
      if (optedOut.delete(id)) notifyOptOut(id, false);
    },

    isOptedOut(userId) {
      return optedOut.has(String(userId));
    },

    forgetUser(userId) {
      return transport.forgetUser(userId);
    },

    on(event, listener) {
      return transport.on(event, listener);
    },

    flush() {
      const window = restHooks?.drain();
      if (window && !disabled.has('rest')) enqueue(window, 1);
      return transport.flush();
    },

    shutdown(opts = {}) {
      stopping ??= stop(opts);
      return stopping;
    },

    stats() {
      return { ...transport.stats(), pendingInteractions: tracker?.pendingCount ?? 0 };
    },
  };
}
