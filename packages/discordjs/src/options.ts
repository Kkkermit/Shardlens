import type { Logger, SaltPeriod, ShardlensExporter } from '@shardlens/core';

/** Metric groups that can be switched off with {@link ShardlensOptions.disable}. */
export type MetricGroup = 'interactions' | 'guilds' | 'rest' | 'gateway' | 'process' | 'premium' | 'app';

/** Options for `createShardlens(client, options)`. Every one is optional. */
export interface ShardlensOptions {
  /**
   * Your collector's URL, for example `https://stats.example.com`. HTTPS, or HTTP to localhost only. Leave out with
   * `apiKey` to run with exporters only.
   */
  endpoint?: string | undefined;
  /** Ingest-only API key (`slk_ingest_…`). */
  apiKey?: string | undefined;
  /**
   * In-process metrics exporters, such as `prometheusExporter()` from `@shardlens/exporter-prometheus`. They get every
   * event before sampling, never with a user. Works with or without a collector.
   */
  exporters?: readonly ShardlensExporter[] | undefined;
  /**
   * Whether users are hashed or identified. `'privacy'` (default): user IDs are hashed in-process and never leave
   * the bot. `'audit'`: also sends who ran each interaction (user ID, username and avatar), encrypted at rest; only
   * takes effect when the collector is in audit mode too. See the audit-mode guide before turning it on.
   */
  mode?: 'privacy' | 'audit' | undefined;
  /**
   * Audit mode only: send each user's username and avatar with their ID. Default `true`; `false` records IDs only.
   * Nothing else about a user is ever collected.
   */
  auditIncludeProfile?: boolean | undefined;
  /**
   * Has no effect: the collector decides the salt period (dashboard **Settings → User identity**), and the SDK hashes
   * with the salts it is given. Still accepted so configurations that set it keep working.
   *
   * @deprecated Set the salt period on the collector.
   */
  saltPeriod?: SaltPeriod | undefined;
  /** Memory ceiling, in events. Default 10,000. */
  maxQueueSize?: number | undefined;
  /** Flush interval. Default 5,000 ms. */
  flushIntervalMs?: number | undefined;
  /** Events per batch (max 499 plus one health event). Default 499. */
  maxBatchSize?: number | undefined;
  /**
   * Option names whose values may be recorded, for slash commands and for the `optionValues` you pass with message
   * commands. Values of user, channel, role, mentionable and attachment options, and any value holding a Discord ID,
   * are never recorded; strings are cut to 100 characters. Default none.
   */
  captureOptionValues?: readonly string[] | undefined;
  /** Replaces the default custom-ID normaliser (numbers and IDs become `*`). */
  normaliseCustomId?: ((customId: string) => string) | undefined;
  /**
   * Sample rate per event type in (0, 1], for very large bots, such as `{ gauge_window: 0.5 }`. Counts are re-weighted.
   * Rates below 1/10,000 are raised to 1/10,000, the most one kept event can stand for.
   */
  sampleRate?: Readonly<Record<string, number>> | undefined;
  /** Separates staging from production. Default `'production'`. */
  environment?: string | undefined;
  /** Your bot's version, to compare releases. */
  release?: string | undefined;
  /** Print events to the console instead of sending them. */
  dryRun?: boolean | undefined;
  /** Turn off whole metric groups. `'interactions'` also turns off message (prefix) commands. */
  disable?: readonly MetricGroup[] | undefined;
  /** Where SDK warnings go. Default `console`. */
  logger?: Logger | undefined;
  /**
   * Users who opted out earlier (for example loaded from your database). Their events are dropped in-process. BigInt
   * IDs, as some database clients return them, are accepted.
   */
  optedOut?: Iterable<string | bigint> | undefined;
  /**
   * Called when a user opts out or back in, so you can persist the choice. It may be async: if it throws or its
   * promise rejects, the failure is counted (see `lens.on('error')`), never thrown into your bot.
   */
  onOptOutChange?: ((userId: string, optedOut: boolean) => void) | undefined;
  /**
   * Keep events on disk during long collector outages and across restarts: `{ dir: './shardlens-spool' }`. Used when
   * memory is half full while the collector is unreachable, and on `shutdown()` for anything unsent; replayed first
   * when the collector is back. Capped at `maxBytes` (default 100 MB): at the cap the oldest batches are dropped first,
   * and counted in `stats().dropped.spool_evicted`. Files hold hashed events only, never user IDs or audit-mode
   * identities. Default: off (memory only).
   */
  spool?: { dir: string; maxBytes?: number | undefined } | undefined;
  /**
   * Refresh each server's approximate member count with `GET /guilds/{id}?with_counts=true`, one server every two
   * seconds (30 a minute, on your bot's REST budget), instead of only at startup and join. Presence counts are never
   * read. Default `false`.
   */
  refreshGuildCounts?: boolean | undefined;
  /** Override `fetch` (tests, proxies). */
  fetch?: typeof fetch | undefined;
}
