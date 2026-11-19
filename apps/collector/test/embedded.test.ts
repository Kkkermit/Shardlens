import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { type AddressInfo, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShardlensClient, uuidv7, type WireEvent } from '@shardlens/core';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { type EmbeddedCollector, type EventSink, type StoredEvent, startEmbeddedCollector } from '../src/embedded.js';

const APP_ID = '1234567890123456789';
const dataDir = mkdtempSync(join(tmpdir(), 'shardlens-embedded-'));
let collector: EmbeddedCollector | undefined;

/**
 * Known secrets, written to a data folder before the collector starts. Requests use these, not the keys the collector
 * hands back: those are read from a file, and sending file data over the network is what code scanning looks for.
 */
const SECRETS = {
  sessionSecret: 's'.repeat(64),
  settingsKey: Buffer.alloc(32, 4).toString('base64'),
  ingestKey: `slk_ingest_${'I'.repeat(43)}`,
  readKey: `slk_read_${'R'.repeat(43)}`,
  activityKey: `slk_activity_${'A'.repeat(43)}`,
};
const writeSecrets = (dir: string, secrets: Partial<typeof SECRETS>) =>
  writeFileSync(join(dir, 'secrets.json'), JSON.stringify(secrets));
const privateFile = (path: string) => process.platform === 'win32' || (statSync(path).mode & 0o777) === 0o600;

afterAll(async () => {
  await collector?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function query(c: EmbeddedCollector, spec: object) {
  const res = await fetch(`${c.url}/v1/query`, {
    method: 'POST',
    headers: { authorization: `Bearer ${SECRETS.readKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(spec),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const range = () => ({
  from: new Date(Date.now() - 3_600_000).toISOString(),
  to: new Date(Date.now() + 60_000).toISOString(),
});

describe('embedded collector (PGlite)', () => {
  it("makes its secrets on first start, in a file only the bot's user can read", { timeout: 60_000 }, async () => {
    const own = mkdtempSync(join(tmpdir(), 'shardlens-embedded-new-'));
    const fresh = await startEmbeddedCollector({ dataDir: own, appId: APP_ID, port: 0, logLevel: 'silent' });
    try {
      expect(fresh.ingestKey).toMatch(/^slk_ingest_[\w-]{43}$/);
      expect(fresh.readKey).toMatch(/^slk_read_[\w-]{43}$/);
      expect(fresh.activityKey).toMatch(/^slk_activity_[\w-]{43}$/);
      const file = join(own, 'secrets.json');
      expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
        ingestKey: fresh.ingestKey,
        readKey: fresh.readKey,
      });
      expect(privateFile(file)).toBe(true);
    } finally {
      await fresh.close();
      rmSync(own, { recursive: true, force: true });
    }
  });

  it('adds the keys a secrets.json from an older version lacks, and keeps the rest', { timeout: 60_000 }, async () => {
    const own = mkdtempSync(join(tmpdir(), 'shardlens-embedded-old-'));
    const { activityKey: _, ...older } = SECRETS;
    writeSecrets(own, older);
    const upgraded = await startEmbeddedCollector({ dataDir: own, appId: APP_ID, port: 0, logLevel: 'silent' });
    try {
      expect(upgraded).toMatchObject({ ingestKey: older.ingestKey, readKey: older.readKey });
      expect(upgraded.activityKey).toMatch(/^slk_activity_[\w-]{43}$/);
      const file = join(own, 'secrets.json');
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ ...older, activityKey: upgraded.activityKey });
      expect(privateFile(file)).toBe(true);
    } finally {
      await upgraded.close();
      rmSync(own, { recursive: true, force: true });
    }
  });

  it('refuses to start on a secrets.json it cannot read, instead of writing new keys over it', async () => {
    const own = mkdtempSync(join(tmpdir(), 'shardlens-embedded-broken-'));
    writeFileSync(join(own, 'secrets.json'), '{ not json');
    try {
      await expect(
        startEmbeddedCollector({ dataDir: own, appId: APP_ID, port: 0, logLevel: 'silent' }),
      ).rejects.toThrow(SyntaxError);
      expect(readFileSync(join(own, 'secrets.json'), 'utf8')).toBe('{ not json');
    } finally {
      rmSync(own, { recursive: true, force: true });
    }
  });

  it(
    'starts in a folder, accepts batches from the real SDK client and answers queries',
    {
      timeout: 60_000,
    },
    async () => {
      writeSecrets(dataDir, SECRETS);
      collector = await startEmbeddedCollector({ dataDir, appId: APP_ID, port: 0, logLevel: 'silent' });
      expect(collector.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(collector).toMatchObject({ ingestKey: SECRETS.ingestKey, readKey: SECRETS.readKey });
      expect((await fetch(`${collector.url}/readyz`)).status).toBe(200);

      const client = new ShardlensClient({
        endpoint: collector.url,
        apiKey: SECRETS.ingestKey,
        sdk: { name: '@shardlens/test', version: '0.0.0' },
        source: () => ({ shards: [0], instance: 'embedded-test' }),
        logger: { warn: () => undefined },
      });
      await client.idle();
      expect(client.ready).toBe(true);
      for (const user of ['300000000000000001', '300000000000000002']) {
        client.enqueueWithUser(
          user,
          Date.now(),
          2,
          (hash) =>
            ({
              id: uuidv7(),
              ts: Date.now(),
              type: 'custom',
              name: 'ticket_opened',
              props: { category: 'billing' },
              user: hash,
            }) as WireEvent,
        );
      }
      await client.idle();
      await client.flush();
      expect(client.stats().failedFlushes).toBe(0);
      await client.shutdown({ timeoutMs: 1_000 });

      const events = await query(collector, { kind: 'events', range: range() });
      expect(events.status).toBe(200);
      expect(events.body.rows).toEqual([expect.objectContaining({ name: 'ticket_opened', count: 2, users: 2 })]);
    },
  );

  it('keeps data and secrets across restarts', { timeout: 60_000 }, async () => {
    const before = collector as EmbeddedCollector;
    await before.close();
    collector = await startEmbeddedCollector({ dataDir, appId: APP_ID, port: 0, logLevel: 'silent' });
    expect(collector).toMatchObject({
      ingestKey: before.ingestKey,
      readKey: before.readKey,
      activityKey: SECRETS.activityKey,
    });
    const events = await query(collector, { kind: 'events', range: range() });
    expect(events.body.rows).toEqual([expect.objectContaining({ name: 'ticket_opened', count: 2 })]);
  });

  it('copies events into a sink you write, without the raw user ID', { timeout: 60_000 }, async () => {
    const stored: StoredEvent[] = [];
    const sink: EventSink = {
      name: 'mine',
      write: async (events) => void stored.push(...events),
      erase: async () => 0,
      expire: async () => 0,
      close: async () => undefined,
    };
    const own = mkdtempSync(join(tmpdir(), 'shardlens-embedded-sink-'));
    writeSecrets(own, SECRETS);
    const withSink = await startEmbeddedCollector({
      dataDir: own,
      appId: APP_ID,
      port: 0,
      logLevel: 'silent',
      sink: { to: sink },
    });
    try {
      const client = new ShardlensClient({
        endpoint: withSink.url,
        apiKey: SECRETS.ingestKey,
        sdk: { name: '@shardlens/test', version: '0.0.0' },
        source: () => ({ shards: [0], instance: 'embedded-sink-test' }),
        logger: { warn: () => undefined },
      });
      await client.idle();
      client.enqueueWithUser(
        '300000000000000009',
        Date.now(),
        2,
        (hash) =>
          ({ id: uuidv7(), ts: Date.now(), type: 'custom', name: 'shop_opened', props: {}, user: hash }) as WireEvent,
      );
      await client.idle();
      await client.flush();
      await client.shutdown({ timeoutMs: 1_000 });
    } finally {
      await withSink.close(); // flushes the sink
      rmSync(own, { recursive: true, force: true });
    }
    // Every accepted event is copied, the SDK's own health report included.
    const custom = stored.filter((e) => e.type === 'custom');
    expect(custom.map((e) => e.data.name)).toEqual(['shop_opened']);
    expect(custom[0]?.userHash).toMatch(/^[0-9a-f]{32}$/);
    expect(stored.map((e) => e.type)).toContain('sdk_health');
    expect(JSON.stringify(stored)).not.toContain('300000000000000009');
  });

  it('refuses a sink URL it cannot use', async () => {
    await expect(
      startEmbeddedCollector({ dataDir, appId: APP_ID, port: 0, sink: { to: 'redis://localhost:6379' } }),
    ).rejects.toThrow(/sink\.to/);
  });

  it(
    'stops everything it started when it cannot listen, so a bot that carries on is left alone',
    {
      timeout: 60_000,
    },
    async () => {
      const taken = createServer();
      await new Promise<void>((resolve) => taken.listen(0, '127.0.0.1', resolve));
      const own = mkdtempSync(join(tmpdir(), 'shardlens-embedded-busy-'));
      const running = new Set<unknown>();
      const { setInterval: set, clearInterval: clear } = globalThis;
      vi.spyOn(globalThis, 'setInterval').mockImplementation(((...args: Parameters<typeof set>) => {
        const timer = set(...args);
        running.add(timer);
        return timer;
      }) as typeof setInterval);
      vi.spyOn(globalThis, 'clearInterval').mockImplementation((timer) => {
        running.delete(timer);
        clear(timer);
      });
      try {
        const port = (taken.address() as AddressInfo).port;
        await expect(startEmbeddedCollector({ dataDir: own, appId: APP_ID, port, logLevel: 'silent' })).rejects.toThrow(
          /EADDRINUSE/,
        );
        expect(running.size).toBe(0);
      } finally {
        vi.restoreAllMocks();
        taken.close();
        rmSync(own, { recursive: true, force: true });
      }
    },
  );

  it(
    'runs without the dashboard, in the mode it is given, with a key for a dashboard of your own',
    { timeout: 60_000 },
    async () => {
      const own = mkdtempSync(join(tmpdir(), 'shardlens-embedded-headless-'));
      writeSecrets(own, SECRETS);
      const options = { dataDir: own, appId: APP_ID, port: 0, logLevel: 'silent', dashboard: false } as const;
      await expect(startEmbeddedCollector({ ...options, mode: 'audit' })).rejects.toThrow(/needs auditKey/);
      const headless = await startEmbeddedCollector({
        ...options,
        mode: 'audit',
        auditKey: Buffer.alloc(32, 3).toString('base64'),
      });
      try {
        expect(await (await fetch(`${headless.url}/`)).json()).toEqual({
          name: 'shardlens-collector',
          dashboard: 'off',
        });
        const get = (path: string, key: string) =>
          fetch(`${headless.url}${path}`, { headers: { authorization: `Bearer ${key}` } });
        // Audit mode without a Settings page to choose it in, read without a Discord sign-in.
        expect(await (await get('/v1/meta', SECRETS.readKey)).json()).toMatchObject({ mode: 'audit' });
        const log = await get('/v1/audit/log', SECRETS.activityKey);
        expect(log.status).toBe(200);
        expect(await log.json()).toEqual({ rows: [], nextBefore: null });
        expect((await get('/v1/audit/log', SECRETS.readKey)).status).toBe(403);
      } finally {
        await headless.close();
        rmSync(own, { recursive: true, force: true });
      }
    },
  );

  it('refuses requests without a key, like the standalone collector', async () => {
    const res = await fetch(`${(collector as EmbeddedCollector).url}/v1/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'events', range: range() }),
    });
    expect(res.status).toBe(401);
  });
});
