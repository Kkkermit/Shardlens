import type { FastifyInstance } from 'fastify';
import type { Db } from './db.js';
import { type Config, dashboardUrl } from './env.js';
import { type Jobs, startJobs } from './jobs/scheduler.js';
import { LiveHub } from './live.js';
import { KeyStore, seedKey } from './security/auth.js';
import { buildServer } from './server.js';
import type { ClickHouseStore } from './storage/clickhouse.js';
import { PostgresStore } from './storage/postgres/store.js';
import { activeSalts } from './storage/salts.js';
import { createSink, SinkMirror } from './storage/sink.js';
import type { Store } from './storage/store.js';

/**
 * Set-ups that start but can't be used: no key for the bot, or no way into the dashboard. Keys made in the dashboard
 * count, so a collector whose keys were created there and later removed from the environment is fine.
 */
export async function signInProblems(store: Store, config: Config): Promise<string[]> {
  const scopes = new Set(await store.keys.activeScopes(config.appId));
  const problems: string[] = [];
  if (!scopes.has('ingest')) {
    problems.push(
      'No ingest key: the bot cannot send events. Set SHARDLENS_INGEST_KEY (npx shardlens keys makes one).',
    );
  }
  if (!config.dashboard) {
    // Keys are created in the dashboard's Settings, so with it off only the environment can provide one.
    if (!scopes.has('read') && !scopes.has('activity')) {
      problems.push(
        'No read key, and the dashboard is off: nothing can read the numbers. Set SHARDLENS_READ_KEY (npx shardlens keys --scope read makes one).',
      );
    }
    return problems;
  }
  if (!scopes.has('read') && !config.discord) {
    problems.push(
      'No way to open the dashboard: set SHARDLENS_READ_KEY, or DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET for Discord sign-in.',
    );
  } else if (!scopes.has('read') && config.extraAdmins.length === 0) {
    if (!(await store.apps.hasReported(config.appId))) {
      problems.push(
        'Discord sign-in works once the bot has reported its owner and team. Until then, set SHARDLENS_READ_KEY or add your Discord user ID to SHARDLENS_EXTRA_ADMINS.',
      );
    }
  }
  return problems;
}

interface RunningCollector {
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
  const store = new PostgresStore(db);
  await store.apps.register(config.appId);
  if (config.ingestKey) await seedKey(store, config.appId, config.ingestKey, 'SHARDLENS_INGEST_KEY');
  if (config.readKey) await seedKey(store, config.appId, config.readKey, 'SHARDLENS_READ_KEY');
  if (config.activityKey) await seedKey(store, config.appId, config.activityKey, 'SHARDLENS_ACTIVITY_KEY');
  if (config.mode && (await store.apps.setMode(config.appId, config.mode))) {
    await store.adminAudit.record(config.appId, null, 'settings_update', { fields: ['mode'], by: 'environment' });
  }
  await store.prepare();
  const appRow = await store.apps.get(config.appId);
  await activeSalts(store, config.appId, appRow?.saltPeriod ?? 'month');

  const live = new LiveHub(db);
  const liveShared = await live.start();
  // Loaded only when configured: embedded mode and most installs never need the ClickHouse client.
  const analytics: ClickHouseStore | undefined = config.clickhouseUrl
    ? new (await import('./storage/clickhouse.js')).ClickHouseStore(config.clickhouseUrl)
    : undefined;
  let sink: SinkMirror | undefined;
  let server: FastifyInstance | undefined;
  let jobs: Jobs | undefined;
  let stopped: Promise<void> | undefined;
  const stop = () => {
    stopped ??= (async () => {
      await server?.close().catch(() => undefined);
      await jobs?.stop();
      await live.stop();
      await analytics?.stop().catch(() => undefined);
      await sink?.stop().catch(() => undefined);
    })();
    return stopped;
  };

  try {
    const sinkTo = config.sink?.to;
    if (sinkTo !== undefined) {
      sink = new SinkMirror(
        typeof sinkTo === 'string' ? await createSink(sinkTo, config.sink?.table) : sinkTo,
        config.sink,
      );
    }
    const app = await buildServer({ config, store, db, keys: new KeyStore(store), live, analytics, sink });
    server = app;
    sink?.start((message) => app.log.warn({ component: 'sink' }, message));
    if (analytics) {
      await analytics.migrate();
      analytics.start((message) => app.log.warn({ component: 'clickhouse' }, message));
    }
    for (const problem of await signInProblems(store, config)) app.log.warn(problem);
    if (config.demo) {
      app.log.warn('Demo mode: anyone can view this dashboard without signing in. Use it only with demo data.');
    }
    live.onWarning((message) => app.log.warn({ component: 'live' }, message));
    if (!liveShared) {
      app.log.warn('Live tiles are not shared between collector instances yet: LISTEN failed on PostgreSQL. Retrying.');
    }
    jobs = startJobs(db, app.log, { settingsKey: config.settingsKey, dashboardUrl: dashboardUrl(config) });
    const address = await app.listen({ port: config.port, host: config.host });
    app.log.info(
      {
        appId: config.appId,
        discordLogin: config.discord !== undefined,
        webhookEvents: config.discordPublicKey !== undefined,
        auditKey: config.auditKey !== undefined,
        mode: appRow?.mode,
        modeFrom: config.mode ? 'environment' : 'settings',
        dashboard: config.dashboard,
        clickhouse: analytics !== undefined,
        sink: sink?.name ?? false,
        demo: config.demo,
        migrationsApplied,
      },
      'Shardlens collector started',
    );
    return { server: app, address, stop };
  } catch (error) {
    // Embedded mode keeps the bot's process running after a failed start (a port in use, say), so nothing started
    // here may keep running against a database that is about to be closed.
    await stop();
    throw error;
  }
}
