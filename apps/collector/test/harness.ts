import { createHash, randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { UserHasher, uuidv7 } from '@shardlens/core';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { FastifyInstance } from 'fastify';
import { GenericContainer, Wait } from 'testcontainers';
import { createPool, type Db, migrate } from '../src/db.js';
import type { Config } from '../src/env.js';
import { LiveHub } from '../src/live.js';
import { KeyStore, seedKey } from '../src/security/auth.js';
import type { SignInLinks } from '../src/security/sign-in-links.js';
import { buildServer } from '../src/server.js';
import type { ClickHouseStore } from '../src/storage/clickhouse.js';
import { openMongo } from '../src/storage/mongodb/connect.js';
import { MongoStore } from '../src/storage/mongodb/store.js';
import { PostgresStore } from '../src/storage/postgres/store.js';
import type { Store } from '../src/storage/store.js';

export const APP_ID = '1234567890123456789';
export const INGEST_KEY = `slk_ingest_${'A'.repeat(43)}`;
export const READ_KEY = `slk_read_${'B'.repeat(43)}`;

/** A store for the suites to run against, on a fresh database. */
interface StoreUnderTest {
  store: Store;
  /** Its connection URL (`Config.databaseUrl`). */
  databaseUrl: string;
  /** The PostgreSQL pool behind the store, when it has one. */
  db?: Db | undefined;
  /** Stops the store and its database. */
  close(): Promise<void>;
}

/** Builds a store on a database of its own, migrated and empty. */
export type StoreFactory = () => Promise<StoreUnderTest>;

/** PostgreSQL in a container (16 by default: the oldest supported), migrated. */
const postgresStore: StoreFactory = async () => {
  const image = process.env.SHARDLENS_TEST_PG_IMAGE ?? 'postgres:16-alpine';
  const container = await new PostgreSqlContainer(image).start();
  const url = container.getConnectionUri();
  await migrate(url);
  const db = createPool(url, 8);
  return {
    store: new PostgresStore(db),
    databaseUrl: url,
    db,
    async close() {
      await db.end();
      await container.stop();
    },
  };
};

/**
 * A standalone MongoDB server in a container (7.0 by default: the oldest supported), not a replica set: MongoStore
 * must need neither transactions nor change streams.
 */
export const mongoStore: StoreFactory = async () => {
  const image = process.env.SHARDLENS_TEST_MONGO_IMAGE ?? 'mongo:7.0';
  const container = await new GenericContainer(image)
    .withExposedPorts(27017)
    .withWaitStrategy(Wait.forLogMessage(/Waiting for connections/))
    .start();
  const url = `mongodb://${container.getHost()}:${container.getMappedPort(27017)}/shardlens_test`;
  const m = await openMongo(url);
  return {
    store: new MongoStore(m),
    databaseUrl: url,
    async close() {
      await m.client.close();
      await container.stop();
    },
  };
};

/** The store the suites run on: MongoDB with `SHARDLENS_TEST_STORE=mongodb` (`pnpm test:int:mongodb`), else PostgreSQL. */
export const onPostgres = process.env.SHARDLENS_TEST_STORE !== 'mongodb';

export interface Harness {
  store: Store;
  /**
   * The PostgreSQL pool behind `store`, for tests that set up or check rows directly. Those tests are PostgreSQL's
   * own (`it.runIf(onPostgres)`): with another store, reading this throws.
   */
  readonly db: Db;
  app: FastifyInstance;
  live: LiveHub;
  config: Config;
  close(): Promise<void>;
}

/** A collector on a fresh store (as `onPostgres` says, unless `store` does), with one app and two keys. */
export async function startHarness(
  opts: {
    discordPublicKey?: string;
    auditKey?: string;
    demo?: boolean;
    analytics?: ClickHouseStore;
    extraAdmins?: string[];
    store?: StoreFactory;
    signInLinks?: SignInLinks;
  } = {},
): Promise<Harness> {
  const backing = await (opts.store ?? (onPostgres ? postgresStore : mongoStore))();
  const { store } = backing;
  await store.apps.register(APP_ID);
  await seedKey(store, APP_ID, INGEST_KEY, 'test ingest');
  await seedKey(store, APP_ID, READ_KEY, 'test read');
  await store.prepare();
  const config: Config = {
    databaseUrl: backing.databaseUrl,
    publicUrl: new URL('https://stats.example.com'),
    appId: APP_ID,
    sessionSecret: 'x'.repeat(48),
    settingsKey: Buffer.alloc(32, 1).toString('base64'),
    auditKey: opts.auditKey,
    discord: undefined,
    discordPublicKey: opts.discordPublicKey,
    ingestKey: INGEST_KEY,
    readKey: READ_KEY,
    extraAdmins: opts.extraAdmins ?? [],
    trustProxy: false,
    demo: opts.demo ?? false,
    dashboard: true,
    dashboardDir: undefined,
    port: 0,
    host: '127.0.0.1',
    logLevel: process.env.SHARDLENS_TEST_LOG ?? 'silent',
  };
  const live = new LiveHub(store.live.channel());
  await live.start();
  const app = await buildServer({
    config,
    store,
    keys: new KeyStore(store),
    live,
    analytics: opts.analytics,
    signInLinks: opts.signInLinks,
  });
  await app.ready();
  return {
    store,
    get db() {
      if (!backing.db) throw new Error('This test needs PostgreSQL: it reads or writes rows directly.');
      return backing.db;
    },
    app,
    live,
    config,
    async close() {
      await app.close();
      await live.stop();
      await backing.close();
    },
  };
}

/** Fetches salts the way the SDK does and returns a hasher for the current period. */
export async function sdkHasher(app: FastifyInstance): Promise<{ hasher: UserHasher; period: string }> {
  const res = await app.inject({
    method: 'GET',
    url: '/v1/config',
    headers: { authorization: `Bearer ${INGEST_KEY}` },
  });
  const config = res.json() as { salts: { period: string; salt: string }[] };
  const hasher = new UserHasher();
  for (const s of [...config.salts].reverse()) await hasher.setSalt(s.period, Buffer.from(s.salt, 'base64url'));
  return { hasher, period: config.salts[0]!.period };
}

export function envelope(events: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    mode: 'privacy',
    sdk: { name: '@shardlens/discordjs', version: '1.0.0' },
    app: { id: APP_ID, env: 'production', release: '2.4.1' },
    source: { shards: [0], instance: 'test:1' },
    sentAt: new Date().toISOString(),
    events,
    ...overrides,
  };
}

export function ingest(app: FastifyInstance, body: unknown, key = INGEST_KEY) {
  return app.inject({
    method: 'POST',
    url: '/v1/ingest',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'content-encoding': 'gzip' },
    payload: gzipSync(Buffer.from(JSON.stringify(body))),
  });
}

export function query(app: FastifyInstance, spec: object) {
  return app.inject({
    method: 'POST',
    url: '/v1/query',
    headers: { authorization: `Bearer ${READ_KEY}` },
    payload: spec,
  });
}

export function interaction(user: string, overrides: Record<string, unknown> = {}) {
  return {
    id: uuidv7(),
    ts: Date.now(),
    type: 'interaction',
    kind: 'chat_input',
    command: 'ticket',
    sub: 'open',
    options: ['category'],
    context: 0,
    install: 'guild',
    guild: '112233445566778899',
    locale: 'en-GB',
    memberTier: 'member',
    user,
    premium: false,
    outcome: 'ok',
    ackMs: 120,
    deferred: false,
    ...overrides,
  };
}

export function guildInfo(id: string, overrides: Record<string, unknown> = {}) {
  return {
    guild: id,
    name: 'Test server',
    icon: null,
    memberCount: 42,
    large: false,
    preferredLocale: 'en-GB',
    features: ['COMMUNITY'],
    premiumTier: 0,
    boosts: 0,
    verificationLevel: 1,
    nsfwLevel: 0,
    mfaLevel: 0,
    createdAt: 1600000000000,
    joinedAt: Date.now(),
    shard: 0,
    channelCounts: { '0': 3 },
    roleCount: 2,
    emojiCount: 0,
    stickerCount: 0,
    botPermissions: '2048',
    ...overrides,
  };
}

/** A snowflake whose shard (for `count` shards) is `shard`. */
export function snowflakeOnShard(shard: number, count: number, seq: number): string {
  const base = (BigInt(Date.now() - 1420070400000) << 22n) + BigInt(seq);
  for (let i = 0n; i < 10_000n; i++) {
    const id = base + (i << 22n);
    if (Number((id >> 22n) % BigInt(count)) === shard) return id.toString();
  }
  throw new Error('no snowflake found');
}

/** Creates a dashboard session directly (as if the user signed in) and returns the cookie value. */
export async function testSession(
  store: Store,
  method: 'discord' | 'read_key',
  userId: string | null = '987654321098765432',
) {
  const token = randomBytes(32).toString('base64url');
  await store.sessions.create({
    idSha256: createHash('sha256').update(token).digest(),
    appId: APP_ID,
    userId,
    method,
    keyId: null,
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  return token;
}
