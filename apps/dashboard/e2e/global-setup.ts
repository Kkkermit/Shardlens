import { type ChildProcess, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { ADMIN_ID, APP_ID, BASE_URL, INGEST_KEY, PORT, READ_KEY, XSS_NAME } from './env';

const collectorDist = fileURLToPath(new URL('../../collector/dist/', import.meta.url));
const dashboardDist = fileURLToPath(new URL('../dist/', import.meta.url));

async function waitForReady(url: string, child: ChildProcess, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`collector exited with code ${child.exitCode}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`collector not ready at ${url}`);
}

function run(script: string, env: NodeJS.ProcessEnv) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [script], { env, stdio: 'inherit' });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${script} exited with ${code}`))));
  });
}

async function session(db: pg.Client, method: 'discord' | 'read_key', userId: string | null) {
  const token = randomBytes(32).toString('base64url');
  await db.query(
    "INSERT INTO sessions (id_sha256, user_id, app_id, method, expires_at) VALUES ($1, $2, $3, $4, now() + interval '2 hours')",
    [createHash('sha256').update(token).digest(), userId, APP_ID, method],
  );
  return token;
}

export default async function globalSetup() {
  if (!existsSync(`${collectorDist}main.js`) || !existsSync(`${dashboardDist}index.html`)) {
    throw new Error('Build first: pnpm turbo run build --filter=@shardlens/collector...');
  }
  const container = await new PostgreSqlContainer(process.env.SHARDLENS_TEST_PG_IMAGE ?? 'postgres:17-alpine').start();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: container.getConnectionUri(),
    SHARDLENS_PUBLIC_URL: BASE_URL,
    SHARDLENS_APP_ID: APP_ID,
    SHARDLENS_SESSION_SECRET: 'e2e-session-secret-'.repeat(3),
    SHARDLENS_SETTINGS_KEY: Buffer.alloc(32, 7).toString('base64'),
    SHARDLENS_AUDIT_KEY: Buffer.alloc(32, 8).toString('base64'),
    SHARDLENS_INGEST_KEY: INGEST_KEY,
    SHARDLENS_READ_KEY: READ_KEY,
    SHARDLENS_EXTRA_ADMINS: ADMIN_ID,
    SHARDLENS_DASHBOARD_DIR: dashboardDist,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    LOG_LEVEL: 'warn',
  };
  const collector = spawn(process.execPath, [`${collectorDist}main.js`], { env, stdio: 'inherit' });
  try {
    await waitForReady(`${BASE_URL}/readyz`, collector);
    // 30 days of fictional traffic through the real SDK client, then rollups.
    await run(`${collectorDist}cli/seed.js`, { ...env, SHARDLENS_URL: BASE_URL });

    const db = new pg.Client({ connectionString: env.DATABASE_URL });
    await db.connect();
    await db.query(
      `UPDATE guilds SET name = $1
        WHERE app_id = $2 AND guild_id = (SELECT guild_id FROM guilds WHERE app_id = $2 ORDER BY member_count DESC LIMIT 1)`,
      [XSS_NAME, APP_ID],
    );
    process.env.SHARDLENS_E2E_READER = await session(db, 'read_key', null);
    process.env.SHARDLENS_E2E_ADMIN = await session(db, 'discord', ADMIN_ID);
    await db.end();
  } catch (error) {
    collector.kill();
    await container.stop();
    throw error;
  }

  return async () => {
    collector.kill();
    await container.stop();
  };
}
