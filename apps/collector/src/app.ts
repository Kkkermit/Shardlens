import type { FastifyInstance } from 'fastify';
import type { Db } from './db.js';
import type { Config } from './env.js';
import { startJobs } from './jobs/scheduler.js';
import { LiveHub } from './live.js';
import { KeyStore, seedKey } from './security/auth.js';
import { buildServer } from './server.js';
import { ClickHouseStore } from './storage/clickhouse.js';
import { activeSalts, ensurePartitions } from './storage/maintenance.js';

export interface RunningCollector {
  readonly server: FastifyInstance;
  /** The address the server listens on, for example `http://127.0.0.1:8080`. */
  readonly address: string;
  /** Stops the HTTP server, background jobs and live updates. Does not close the database. */
  stop(): Promise<void>;
}

/**
 * Bootstrap shared by the standalone collector and embedded mode, after migrations: registers the app and its
 * configured keys, makes sure partitions and salts exist, then starts live updates, the HTTP server and the jobs.
 * `migrationsApplied` (what this start changed in the database) goes into the start-up log line.
 */
export async function startCollector(
  config: Config,
  db: Db,
  migrationsApplied: readonly string[],
): Promise<RunningCollector> {
  await db.query('INSERT INTO apps (app_id) VALUES ($1) ON CONFLICT (app_id) DO NOTHING', [config.appId]);
  if (config.ingestKey) await seedKey(db, config.appId, config.ingestKey, 'SHARDLENS_INGEST_KEY');
  if (config.readKey) await seedKey(db, config.appId, config.readKey, 'SHARDLENS_READ_KEY');
  await ensurePartitions(db);
  const app = await db.query<{ salt_period: 'day' | 'week' | 'month' }>(
    'SELECT salt_period FROM apps WHERE app_id = $1',
    [config.appId],
  );
  await activeSalts(db, config.appId, app.rows[0]?.salt_period ?? 'month');

  const live = new LiveHub(db);
  const liveShared = await live.start();
  const analytics = config.clickhouseUrl ? new ClickHouseStore(config.clickhouseUrl) : undefined;
  const server = await buildServer({ config, db, keys: new KeyStore(db), live, analytics });
  if (analytics) {
    await analytics.migrate();
    analytics.start((message) => server.log.warn({ component: 'clickhouse' }, message));
  }
  if (config.demo) {
    server.log.warn('Demo mode: anyone can view this dashboard without signing in. Use it only with demo data.');
  }
  if (!liveShared) {
    server.log.warn('Live tiles are not shared between collector instances: LISTEN failed on PostgreSQL.');
  }
  const jobs = startJobs(db, server.log, { settingsKey: config.settingsKey, publicUrl: config.publicUrl });
  const address = await server.listen({ port: config.port, host: config.host });
  server.log.info(
    {
      appId: config.appId,
      discordLogin: config.discord !== undefined,
      webhookEvents: config.discordPublicKey !== undefined,
      auditKey: config.auditKey !== undefined,
      clickhouse: analytics !== undefined,
      demo: config.demo,
      migrationsApplied,
    },
    'Shardlens collector started',
  );

  let stopped: Promise<void> | undefined;
  return {
    server,
    address,
    stop() {
      stopped ??= (async () => {
        await server.close().catch(() => undefined);
        await jobs.stop();
        await live.stop();
        await analytics?.stop().catch(() => undefined);
      })();
      return stopped;
    },
  };
}
