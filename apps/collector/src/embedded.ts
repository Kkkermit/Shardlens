/**
 * `@shardlens/collector/embedded`: the whole collector (ingest, jobs, dashboard) inside your bot process, on an
 * in-process PostgreSQL (PGlite) stored in one folder. For small bots on one host that don't want to run anything
 * else. Same code, same privacy model and same dashboard as the standalone collector (ADR 0012).
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startCollector } from './app.js';
import type { Config } from './env.js';
import { applyMigrations } from './migrate.js';
import { PG_COMPATIBLE_PARSERS, pgliteDb } from './storage/pglite.js';
import { SINK_URL, type SinkSettings } from './storage/sink.js';

export type { EventSink, SinkSettings, StoredEvent } from './storage/sink.js';

export interface EmbeddedCollectorOptions {
  /** Folder for the database and the generated secrets. Created if missing. Back it up, and keep it private. */
  dataDir: string;
  appId: string;
  /** Port for the dashboard and API. Default 8080. */
  port?: number | undefined;
  /** Address to listen on. Default `127.0.0.1`: only this machine can reach the dashboard. */
  host?: string | undefined;
  /** The URL people open the dashboard at, for sign-in redirects and links in alerts. Default `http://localhost:<port>`. */
  publicUrl?: string | undefined;
  /** "Sign in with Discord" for the dashboard. */
  discord?: { clientId: string; clientSecret: string } | undefined;
  /** Your application's public key, to receive Discord webhook events (needs a public HTTPS URL). */
  discordPublicKey?: string | undefined;
  /** Discord user IDs allowed into the dashboard besides the app owner and team. */
  extraAdmins?: readonly string[] | undefined;
  /** 32 random bytes, base64, to allow audit mode. Keep it outside `dataDir` (and back it up). */
  auditKey?: string | undefined;
  /** `true` behind a reverse proxy. Default `false`. */
  trustProxy?: boolean | undefined;
  /** Collector log level. Default `warn`, so your bot's logs stay quiet. */
  logLevel?: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent' | undefined;
  /**
   * Also copy every accepted event into your own database: `{ to: process.env.MONGODB_URI }` for MongoDB, or a
   * `mysql://`, `mariadb://`, `postgres://` or `sqlite:` URL, or an {@link EventSink} you write. The dashboard keeps
   * using the embedded database. Copies hold hashed users only, and erasure and retention reach them.
   */
  sink?: SinkSettings | undefined;
}

export interface EmbeddedCollector {
  /** Where the SDK sends events: pass it as `endpoint` to `createShardlens`. */
  readonly url: string;
  readonly dashboardUrl: string;
  /** Ingest key for the SDK (generated on first start, kept in `dataDir`). */
  readonly ingestKey: string;
  /** Read key to sign in to the dashboard (generated on first start, kept in `dataDir`). */
  readonly readKey: string;
  close(): Promise<void>;
}

interface Secrets {
  sessionSecret: string;
  settingsKey: string;
  ingestKey: string;
  readKey: string;
}

/** Secrets are generated once and stored next to the database, readable by the bot's user only. */
function loadSecrets(dataDir: string): Secrets {
  const file = join(dataDir, 'secrets.json');
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as Secrets;
  const secrets: Secrets = {
    sessionSecret: randomBytes(48).toString('base64url'),
    settingsKey: randomBytes(32).toString('base64'),
    ingestKey: `slk_ingest_${randomBytes(32).toString('base64url')}`,
    readKey: `slk_read_${randomBytes(32).toString('base64url')}`,
  };
  writeFileSync(file, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // not supported on every platform
  }
  return secrets;
}

/**
 * Starts the collector inside this process. Resolves once the dashboard is listening. The first start creates the
 * database and secrets in `dataDir`; later starts reuse them and apply any new migrations.
 */
export async function startEmbeddedCollector(options: EmbeddedCollectorOptions): Promise<EmbeddedCollector> {
  if (!/^\d{17,20}$/.test(options.appId))
    throw new Error('startEmbeddedCollector: appId must be your Discord application ID');
  if (typeof options.sink?.to === 'string' && !SINK_URL.test(options.sink.to)) {
    throw new Error('startEmbeddedCollector: sink.to must be a mongodb:, mysql:, mariadb:, postgres: or sqlite: URL');
  }
  let PGlite: typeof import('@electric-sql/pglite').PGlite;
  try {
    ({ PGlite } = await import('@electric-sql/pglite'));
  } catch {
    throw new Error('Embedded mode needs PGlite: npm install @electric-sql/pglite');
  }

  const dataDir = resolve(options.dataDir);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const secrets = loadSecrets(dataDir);
  const port = options.port ?? 8080;
  const host = options.host ?? '127.0.0.1';
  const publicUrl = new URL(options.publicUrl ?? `http://localhost:${port}`);

  const pg = await PGlite.create({ dataDir: join(dataDir, 'db'), parsers: PG_COMPATIBLE_PARSERS });
  try {
    const migrationsApplied = await applyMigrations(pg);
    const db = pgliteDb(pg);
    const config: Config = {
      databaseUrl: 'pglite',
      publicUrl,
      appId: options.appId,
      sessionSecret: secrets.sessionSecret,
      settingsKey: secrets.settingsKey,
      auditKey: options.auditKey,
      discord: options.discord,
      discordPublicKey: options.discordPublicKey,
      ingestKey: secrets.ingestKey,
      readKey: secrets.readKey,
      extraAdmins: [...(options.extraAdmins ?? [])],
      trustProxy: options.trustProxy ?? false,
      demo: false,
      dashboardDir: undefined,
      port,
      host,
      logLevel: options.logLevel ?? 'warn',
      sink: options.sink,
    };
    const collector = await startCollector(config, db, migrationsApplied);
    const listening = new URL(collector.address);
    // The SDK talks to the loopback address even when the dashboard listens more widely.
    const url = `http://127.0.0.1:${listening.port}`;
    let closed: Promise<void> | undefined;
    return {
      url,
      dashboardUrl: options.publicUrl ?? `http://localhost:${listening.port}`,
      ingestKey: secrets.ingestKey,
      readKey: secrets.readKey,
      close() {
        closed ??= (async () => {
          await collector.stop();
          await pg.close();
        })();
        return closed;
      },
    };
  } catch (error) {
    await pg.close().catch(() => undefined);
    throw error;
  }
}
