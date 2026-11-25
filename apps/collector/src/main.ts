import { startCollector } from './app.js';
import { createPool, migrate } from './db.js';
import { loadConfig } from './env.js';
import { MONGODB_URL, openMongo } from './storage/mongodb/connect.js';
import { appSecrets, seedGeneratedKeys } from './storage/mongodb/secrets.js';
import { MongoStore } from './storage/mongodb/store.js';
import { PostgresStore } from './storage/postgres/store.js';

/** Starts on PostgreSQL, or on MongoDB when `DATABASE_URL` is a `mongodb://` or `mongodb+srv://` URL (ADR 0022). */
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL?.trim() ?? '';
  const { collector, close } = MONGODB_URL.test(url) ? await onMongo(url) : await onPostgres();

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    collector.server.log.info({ signal }, 'shutting down');
    await collector.stop();
    await close();
    process.exit(0);
  };
  process.once('SIGTERM', () => void stop('SIGTERM'));
  process.once('SIGINT', () => void stop('SIGINT'));
}

async function onPostgres() {
  const config = loadConfig();
  const migrationsApplied = await migrate(config.databaseUrl);
  const db = createPool(config.databaseUrl);
  return { collector: await startCollector(config, new PostgresStore(db), migrationsApplied), close: () => db.end() };
}

/**
 * The session secret and settings key may be left out: the ones the bot's own collector generated in the database are
 * used, and its keys keep working beside any set here.
 */
async function onMongo(url: string) {
  const m = await openMongo(url);
  try {
    const appId = process.env.SHARDLENS_APP_ID?.trim() ?? '';
    const secrets = /^\d{17,20}$/.test(appId) ? await appSecrets(m.c, appId) : undefined;
    const config = loadConfig({
      ...process.env,
      SHARDLENS_SESSION_SECRET: process.env.SHARDLENS_SESSION_SECRET?.trim() || secrets?.sessionSecret,
      SHARDLENS_SETTINGS_KEY: process.env.SHARDLENS_SETTINGS_KEY?.trim() || secrets?.settingsKey,
    });
    const store = new MongoStore(m);
    if (secrets) await seedGeneratedKeys(store, config.appId, secrets);
    return { collector: await startCollector(config, store, []), close: () => m.client.close() };
  } catch (error) {
    await m.client.close().catch(() => undefined);
    throw error;
  }
}

main().catch((error: unknown) => {
  // Configuration errors name variables, never values.
  console.error(`Shardlens collector could not start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
