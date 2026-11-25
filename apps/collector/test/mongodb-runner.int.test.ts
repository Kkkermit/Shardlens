import { ShardlensClient, uuidv7, type WireEvent } from '@shardlens/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type MongoCollector, startMongoCollector } from '../src/mongodb.js';
import type { MongoStore } from '../src/storage/mongodb/store.js';
import { mongoStore } from './harness.js';

const APP_ID = '1234567890123456789';

/** The collector inside the bot, as `createShardlens(client, { mongodb })` starts it: no port, keys or server. */
describe('the MongoDB runner', () => {
  let backing: Awaited<ReturnType<typeof mongoStore>>;
  const started: MongoCollector[] = [];
  const start = async (options: Partial<Parameters<typeof startMongoCollector>[0]> = {}) => {
    const collector = await startMongoCollector({
      uri: backing.databaseUrl,
      appId: APP_ID,
      logLevel: 'silent',
      ...options,
    });
    started.push(collector);
    return collector;
  };

  beforeAll(async () => {
    backing = await mongoStore();
  });
  afterAll(async () => {
    for (const collector of started) await collector.close();
    await backing?.close();
  });

  it('stores what the SDK sends through its in-process fetch', async () => {
    const collector = await start();
    expect(collector.dashboardUrl).toBeUndefined();
    const client = new ShardlensClient({
      // As the SDK's mongodb option does: the URL and key only pass core's checks.
      endpoint: 'http://localhost',
      apiKey: 'slk_ingest_in_process',
      fetch: collector.fetch,
      sdk: { name: '@shardlens/e2e', version: '0.0.0' },
      flushIntervalMs: 60_000,
      source: () => ({ shards: [0], instance: 'mongo:1' }),
      logger: { warn: () => undefined },
    });
    for (let i = 0; i < 50 && !client.ready; i++) await new Promise((r) => setTimeout(r, 20));
    expect(client.ready).toBe(true);
    for (let i = 0; i < 12; i++) {
      client.enqueueWithUser(
        String(600000000000000000n + BigInt(i % 3)),
        Date.now(),
        3,
        (user) =>
          ({
            id: uuidv7(),
            ts: Date.now(),
            type: 'interaction',
            kind: 'chat_input',
            command: 'runner',
            options: [],
            locale: 'en-GB',
            user,
            premium: false,
            outcome: 'ok',
            ackMs: 80,
          }) as WireEvent,
      );
    }
    await new Promise((r) => setTimeout(r, 50));
    await client.flush();
    await client.shutdown({ timeoutMs: 2_000 });
    expect(client.stats()).toMatchObject({ queueDepth: 0, failedFlushes: 0 });

    const { c } = (backing.store as MongoStore).mongo;
    const stored = await c.interactions.find({ appId: APP_ID, command: 'runner' }).toArray();
    expect(stored).toHaveLength(12);
    expect(new Set(stored.map((d) => Buffer.from(d.userHash.buffer).toString('hex'))).size).toBe(3);
    expect(JSON.stringify(stored)).not.toContain('60000000000000000');
  });

  it('gives every process of a bot the same keys, and the same secrets', async () => {
    const [a, b] = await Promise.all([start(), start()]);
    expect(a.readKey).toMatch(/^slk_read_[\w-]{43}$/);
    expect(b.readKey).toBe(a.readKey);
    expect(b.activityKey).toBe(a.activityKey);
    const { c } = (backing.store as MongoStore).mongo;
    expect(await c.secrets.countDocuments({ _id: `app:${APP_ID}` })).toBe(1);
  });

  it('serves the dashboard from the first process that asks for the port, and signs in once by link', async () => {
    const port = 18_000 + Math.floor(Math.random() * 1_000);
    const first = await start({ dashboard: { port } });
    const second = await start({ dashboard: { port } });
    expect(first.dashboardUrl).toBe(`http://localhost:${port}`);
    expect(second.dashboardUrl).toBeUndefined();
    expect(second.signInLink()).toBeUndefined();

    const link = first.signInLink();
    expect(link).toMatch(new RegExp(`^http://localhost:${port}/auth/link/[\\w-]{43}$`));
    const signIn = await fetch(link ?? '', { redirect: 'manual' });
    expect(signIn.status).toBe(302);
    const cookie = signIn.headers.get('set-cookie')?.split(';')[0] ?? '';
    const me = (await (await fetch(`http://localhost:${port}/auth/me`, { headers: { cookie } })).json()) as {
      method: string;
    };
    expect(me.method).toBe('link');
    const readyz = await fetch(`http://localhost:${port}/readyz`);
    expect(readyz.status).toBe(200);
  });

  it('finds the app by itself when only one has used the database', async () => {
    const collector = await start({ appId: undefined });
    expect(collector.appId).toBe(APP_ID);
  });

  it('keeps its collections in the database it is told to, for a user allowed into one only', async () => {
    const collector = await start({ appId: '1234567890123456780', database: 'bot_only' });
    const { client } = (backing.store as MongoStore).mongo;
    const there = await client.db('bot_only').collection('shardlens_secrets').countDocuments();
    expect(there).toBe(1);
    expect(collector.appId).toBe('1234567890123456780');
  });

  it('starts with SHARDLENS_SETTINGS_KEY listed in the environment with no value, as a .env often has it', async () => {
    const before = process.env.SHARDLENS_SETTINGS_KEY;
    process.env.SHARDLENS_SETTINGS_KEY = '';
    try {
      const collector = await start();
      expect(collector.appId).toBe(APP_ID);
    } finally {
      if (before === undefined) delete process.env.SHARDLENS_SETTINGS_KEY;
      else process.env.SHARDLENS_SETTINGS_KEY = before;
    }
  });

  it('refuses what it cannot use, before connecting', async () => {
    await expect(startMongoCollector({ uri: 'postgres://localhost/db', appId: APP_ID })).rejects.toThrow(
      'must start with mongodb://',
    );
    await expect(startMongoCollector({ uri: backing.databaseUrl, appId: 'mybot' })).rejects.toThrow(
      'appId must be your Discord application ID',
    );
    await expect(startMongoCollector({ uri: backing.databaseUrl, appId: APP_ID, mode: 'audit' })).rejects.toThrow(
      'needs auditKey',
    );
    await expect(startMongoCollector({ uri: backing.databaseUrl, appId: APP_ID, database: 'a.b' })).rejects.toThrow(
      'database must be a MongoDB database name',
    );
    const short = Buffer.alloc(16).toString('base64');
    await expect(
      startMongoCollector({ uri: backing.databaseUrl, appId: APP_ID, mode: 'audit', auditKey: short }),
    ).rejects.toThrow('auditKey must be 32 random bytes');
    await expect(startMongoCollector({ uri: backing.databaseUrl, appId: APP_ID, settingsKey: short })).rejects.toThrow(
      'settingsKey must be 32 random bytes',
    );
    await expect(
      startMongoCollector({ uri: backing.databaseUrl, appId: APP_ID, dashboard: { publicUrl: 'stats.example.com' } }),
    ).rejects.toThrow('dashboard.publicUrl must be a URL');
  });
});
