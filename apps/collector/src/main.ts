import { startCollector } from './app.js';
import { createPool, migrate } from './db.js';
import { loadConfig } from './env.js';
import { PostgresStore } from './storage/postgres/store.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const migrationsApplied = await migrate(config.databaseUrl);
  const db = createPool(config.databaseUrl);
  const collector = await startCollector(config, new PostgresStore(db), migrationsApplied);

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    collector.server.log.info({ signal }, 'shutting down');
    await collector.stop();
    await db.end();
    process.exit(0);
  };
  process.once('SIGTERM', () => void stop('SIGTERM'));
  process.once('SIGINT', () => void stop('SIGINT'));
}

main().catch((error: unknown) => {
  // Configuration errors name variables, never values.
  console.error(`Shardlens collector could not start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
