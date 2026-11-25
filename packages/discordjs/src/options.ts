import type { Logger, SaltPeriod, ShardlensExporter } from '@shardlens/core';

/** Metric groups that can be switched off with {@link ShardlensOptions.disable}. */
export type MetricGroup = 'interactions' | 'guilds' | 'rest' | 'gateway' | 'process' | 'premium' | 'app';

/** The `mongodb` option in full. */
export interface MongoDBOptions {
  /** Your MongoDB's connection string (`mongodb://` or `mongodb+srv://`): the `MONGODB_URI` your bot already uses. */
  uri: string;
  /**
   * The database to keep Shardlens's collections in, when not the one the connection string names (or `shardlens`
   * when it names none): for a database user allowed into one database only. Pass the same to
   * `npx shardlens dashboard --database`.
   */
  database?: string | undefined;
  /**
   * Also serve the dashboard from the bot, on a port (default 8080) of `127.0.0.1` unless `host` says otherwise. The
   * SDK logs a one-time sign-in link when it starts. With several processes, the first to start serves it. Without
   * this, `npx shardlens dashboard` shows the dashboard on your machine.
   */
  dashboard?:
    | {
        port?: number | undefined;
        host?: string | undefined;
        /** The URL people open the dashboard at, behind a proxy or a domain. */
        publicUrl?: string | undefined;
        /** "Sign in with Discord", besides the one-time links. */
        discord?: { clientId: string; clientSecret: string } | undefined;
        /** Discord user IDs allowed in with Discord sign-in besides the app owner and team. */
        extraAdmins?: readonly string[] | undefined;
        /** Behind a reverse proxy, the number of proxies in front (`1` for one). */
        trustProxy?: boolean | number | undefined;
      }
    | undefined;
  /** 32 random bytes, base64, to allow audit mode (`mode: 'audit'`). Kept out of MongoDB: set it from your environment. */
  auditKey?: string | undefined;
  /** Your application's public key, to receive Discord webhook events (needs a public HTTPS dashboard). */
  discordPublicKey?: string | undefined;
  /**
   * Encrypts the webhook URLs of alerts and reports: 32 random bytes, base64. Default `SHARDLENS_SETTINGS_KEY`, else
   * one generated and kept in the database. Every process must use the same one.
   */
  settingsKey?: string | undefined;
}

/** Options for `createShardlens(client, options)`. Every one is optional. */
export interface ShardlensOptions {
  /**
   * Keep everything in your own MongoDB, with nothing else to run: the connection string your bot already uses, such
   * as `process.env.MONGODB_URI`. Needs `npm install @shardlens/collector`. Shardlens adds collections prefixed
   * `shardlens_` and stores events from this process; `npx shardlens dashboard` shows them. Use instead of `endpoint`
   * and `apiKey`.
   */
  mongodb?: string | MongoDBOptions | undefined;
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
  /**
   * Errors your handlers throw on purpose, for a user's mistake that your error handler then explains (a validation
   * error, a "you need Manage Server"), which shouldn't count as failures: return `true` for those, such as
   * `(error) => error instanceof UserError`. Called with whatever a wrapped handler threw (and the `error` passed to
   * `handlerFinished` and `trackMessageCommand`); the error is still re-thrown to your code. Default: every error is a
   * failure.
   */
  isExpectedError?: ((error: unknown) => boolean) | undefined;
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
