/**
 * `@shardlens/collector/mongodb`: the whole collector on your own MongoDB, inside your bot (ADR 0022). Nothing else
 * to run: no server, Docker, keys or port. The SDK starts it for you with
 * `createShardlens(client, { mongodb: process.env.MONGODB_URI })`, and `npx shardlens dashboard` starts it to show
 * the dashboard. Every process of a sharded bot can run one against the same database: they share keys, and
 * background jobs run in one of them at a time.
 */
import { startCollector } from './app.js';
import type { Config } from './env.js';
import { inProcessFetch } from './in-process-fetch.js';
import { SignInLinks } from './security/sign-in-links.js';
import { MONGODB_URL, openMongo } from './storage/mongodb/connect.js';
import { appSecrets, onlyApp, seedGeneratedKeys } from './storage/mongodb/secrets.js';
import { MongoStore } from './storage/mongodb/store.js';

export interface MongoCollectorOptions {
  /**
   * Your MongoDB's connection string, `mongodb://` or `mongodb+srv://`: the `MONGODB_URI` your bot already uses.
   * Shardlens keeps its collections (prefixed `shardlens_`) in the database the string names, or in `shardlens`. It
   * opens at most 5 connections per process (10 while it serves the dashboard), unless the string sets `maxPoolSize`.
   */
  uri: string;
  /**
   * The database to keep Shardlens's collections in, when not the one the connection string names (or `shardlens`
   * when it names none): for a database user allowed into one database only.
   */
  database?: string | undefined;
  /**
   * Your Discord application ID. Default: the one bot whose collector has run on this database before (what
   * `npx shardlens dashboard` relies on).
   */
  appId?: string | undefined;
  /**
   * Serve the dashboard, and the API `@shardlens/client` reads, on a port. Left out, nothing listens: events are
   * stored from this process, and `npx shardlens dashboard` shows them. When several processes ask for the same port,
   * the first to start serves it.
   */
  dashboard?:
    | {
        /** Default 8080. */
        port?: number | undefined;
        /** Default `127.0.0.1`: only this machine can open the dashboard. */
        host?: string | undefined;
        /** The URL people open the dashboard at, for sign-in redirects and links in alerts. */
        publicUrl?: string | undefined;
        /** "Sign in with Discord", besides the one-time links. */
        discord?: { clientId: string; clientSecret: string } | undefined;
        /** Discord user IDs allowed in with Discord sign-in besides the app owner and team. */
        extraAdmins?: readonly string[] | undefined;
        /** Behind a reverse proxy, the number of proxies in front (`1` for one). */
        trustProxy?: boolean | number | undefined;
      }
    | undefined;
  /** Hashed (`'privacy'`) or identified (`'audit'`) users, instead of the dashboard's Settings. `'audit'` needs `auditKey`. */
  mode?: 'privacy' | 'audit' | undefined;
  /** 32 random bytes, base64, to allow audit mode. Kept out of MongoDB on purpose: set it from your environment. */
  auditKey?: string | undefined;
  /** Your application's public key, to receive Discord webhook events (needs a public HTTPS `dashboard`). */
  discordPublicKey?: string | undefined;
  /**
   * 32 random bytes, base64, that encrypt the webhook URLs of alerts and reports. Default: `SHARDLENS_SETTINGS_KEY`
   * from the environment, else one generated on the first start and kept in `shardlens_secrets`, where anyone who can
   * read the database can read it too. Every process must use the same one.
   */
  settingsKey?: string | undefined;
  /** Collector log level. Default `warn`, so your bot's logs stay quiet. */
  logLevel?: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent' | undefined;
}

export interface MongoCollector {
  /** The app whose events this collector stores. */
  readonly appId: string;
  /**
   * Answers the collector's HTTP API in this process, signed in as the app's ingest key: what the SDK sends its
   * events through (`createShardlens` does this for you).
   */
  readonly fetch: typeof fetch;
  /** Where the dashboard listens, when this process serves it. */
  readonly dashboardUrl: string | undefined;
  /**
   * A link that signs whoever opens it in to the dashboard as the owner, settings included. Each works once, within
   * 15 minutes. `undefined` when this process doesn't serve the dashboard.
   */
  signInLink(): string | undefined;
  /** Signs in to the dashboard (analytics only), and reads every number through `@shardlens/client`. */
  readonly readKey: string;
  /** Reads what a read key does, and who ran what in audit mode. */
  readonly activityKey: string;
  /** Stops the jobs and the dashboard, and closes the connection. */
  close(): Promise<void>;
}

/**
 * Refuses what the collector couldn't use, before anything connects, with an error that names the option: a key that
 * isn't one would otherwise fail the start once connected, and a bad database name the first write.
 */
function checkOptions(options: MongoCollectorOptions, envSettingsKey: string | undefined): void {
  if (typeof options.uri !== 'string' || !MONGODB_URL.test(options.uri)) {
    throw new Error('Shardlens: the MongoDB connection string must start with mongodb:// or mongodb+srv://');
  }
  if (options.appId !== undefined && !/^\d{17,20}$/.test(options.appId)) {
    throw new Error('Shardlens: appId must be your Discord application ID');
  }
  if (options.mode === 'audit' && !options.auditKey) throw new Error("Shardlens: mode 'audit' needs auditKey");
  for (const [name, key] of [
    ['auditKey', options.auditKey],
    ['settingsKey', options.settingsKey],
    ['SHARDLENS_SETTINGS_KEY', options.settingsKey === undefined ? envSettingsKey : undefined],
  ] as const) {
    if (key !== undefined && (typeof key !== 'string' || Buffer.from(key, 'base64').length !== 32)) {
      throw new Error(`Shardlens: ${name} must be 32 random bytes, base64 (openssl rand -base64 32)`);
    }
  }
  // MongoDB's own rule for database names.
  if (options.database !== undefined && !/^[^/\\. "$*<>:|?]{1,63}$/.test(options.database)) {
    throw new Error('Shardlens: database must be a MongoDB database name');
  }
  if (options.dashboard?.publicUrl !== undefined && !URL.canParse(options.dashboard.publicUrl)) {
    throw new Error('Shardlens: dashboard.publicUrl must be a URL, such as https://stats.example.com');
  }
}

/**
 * Starts the collector on your MongoDB in this process. Resolves once it can take events (and, with `dashboard`, once
 * the dashboard listens). The first start of an app creates its collections, indexes and keys.
 */
export async function startMongoCollector(options: MongoCollectorOptions): Promise<MongoCollector> {
  // Empty counts as unset, as it does for the collector image: a `.env` often lists the variable with no value.
  const envSettingsKey = process.env.SHARDLENS_SETTINGS_KEY?.trim() || undefined;
  checkOptions(options, envSettingsKey);

  // Every process of a sharded bot opens its own: the driver's default of 100 connections each could reach a hosted
  // tier's limit. Ingest is one batch at a time; a dashboard's page asks a few queries at once.
  const m = await openMongo(options.uri, 'shardlens', {
    maxPoolSize: options.dashboard ? 10 : 5,
    database: options.database,
  });
  try {
    const appId = options.appId ?? (await onlyApp(m.c));
    const store = new MongoStore(m);
    const secrets = await appSecrets(m.c, appId);
    await seedGeneratedKeys(store, appId, secrets);
    const dashboard = options.dashboard;
    const port = dashboard?.port ?? 8080;
    const host = dashboard?.host ?? '127.0.0.1';
    const publicUrl = new URL(dashboard?.publicUrl ?? `http://localhost:${port}`);
    const config: Config = {
      databaseUrl: 'mongodb',
      publicUrl,
      appId,
      sessionSecret: secrets.sessionSecret,
      settingsKey: options.settingsKey ?? envSettingsKey ?? secrets.settingsKey,
      auditKey: options.auditKey,
      discord: dashboard?.discord,
      discordPublicKey: options.discordPublicKey,
      ingestKey: undefined,
      readKey: undefined,
      mode: options.mode,
      dashboard: dashboard !== undefined,
      extraAdmins: [...(dashboard?.extraAdmins ?? [])],
      trustProxy: dashboard?.trustProxy ?? false,
      demo: false,
      dashboardDir: undefined,
      port,
      host,
      logLevel: options.logLevel ?? 'warn',
    };
    const links = dashboard ? new SignInLinks() : undefined;
    const start = (listen: boolean) =>
      startCollector(config, store, [], { listen, signInLinks: listen ? links : undefined });
    let collector: Awaited<ReturnType<typeof startCollector>>;
    try {
      collector = await start(dashboard !== undefined);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
      // Another process of this bot serves the dashboard already: this one stores its events and leaves it be.
      collector = await start(false);
    }
    const dashboardUrl =
      collector.address === undefined
        ? undefined
        : (dashboard?.publicUrl ?? `http://localhost:${new URL(collector.address).port}`);
    let closed: Promise<void> | undefined;
    return {
      appId,
      fetch: inProcessFetch(collector.server, secrets.ingestKey),
      dashboardUrl,
      signInLink: () => (dashboardUrl && links ? links.issue(dashboardUrl) : undefined),
      readKey: secrets.readKey,
      activityKey: secrets.activityKey,
      close() {
        closed ??= (async () => {
          await collector.stop();
          await m.client.close();
        })();
        return closed;
      },
    };
  } catch (error) {
    await m.client.close().catch(() => undefined);
    throw error;
  }
}
