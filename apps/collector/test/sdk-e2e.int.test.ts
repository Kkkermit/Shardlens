import type { AddressInfo } from 'node:net';
import { ShardlensClient, uuidv7, type WireEvent } from '@shardlens/core';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { APP_ID, type Harness, INGEST_KEY, startHarness } from './harness.js';

let h: Harness;
let endpoint: string;

beforeAll(async () => {
  h = await startHarness();
  await h.app.listen({ port: 0, host: '127.0.0.1' });
  endpoint = `http://127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await h?.close();
});

describe('SDK → collector over HTTP', () => {
  it('bootstraps salts, hashes in-process, sends gzip batches and lands every event once', async () => {
    const client = new ShardlensClient({
      endpoint,
      apiKey: INGEST_KEY,
      sdk: { name: '@shardlens/e2e', version: '0.0.0' },
      flushIntervalMs: 60_000,
      source: () => ({ shards: [0], instance: 'e2e:1' }),
      logger: { warn: () => undefined },
    });
    for (let i = 0; i < 50 && !client.ready; i++) await new Promise((r) => setTimeout(r, 20));
    expect(client.ready).toBe(true);

    const ids: string[] = [];
    for (let i = 0; i < 25; i++) {
      client.enqueueWithUser(String(600000000000000000n + BigInt(i % 5)), Date.now(), 3, (user) => {
        const id = uuidv7();
        ids.push(id);
        return {
          id,
          ts: Date.now(),
          type: 'interaction',
          kind: 'chat_input',
          command: 'e2e',
          options: [],
          locale: 'en-GB',
          user,
          premium: false,
          outcome: 'ok',
          ackMs: 90,
        } as WireEvent;
      });
    }
    client.enqueue(
      { id: uuidv7(), ts: Date.now(), type: 'custom', name: 'e2e_done', props: { ok: true } } as WireEvent,
      2,
    );
    await new Promise((r) => setTimeout(r, 50));
    await client.flush();
    await client.shutdown({ timeoutMs: 2_000 });

    expect(client.stats()).toMatchObject({ queueDepth: 0, failedFlushes: 0 });
    const rows = await h.db.query<{ n: number; users: number }>(
      "SELECT count(*)::int AS n, count(DISTINCT user_hash)::int AS users FROM interactions WHERE command = 'e2e'",
    );
    expect(rows.rows[0]).toEqual({ n: 25, users: 5 });
    const health = await h.db.query('SELECT instance FROM sdk_health WHERE app_id = $1', [APP_ID]);
    expect(health.rows.map((r) => r.instance)).toContain('e2e:1');
    const custom = await h.db.query("SELECT props FROM custom_events WHERE name = 'e2e_done'");
    expect(custom.rows[0]?.props).toEqual({ ok: true });
    // No raw user ID anywhere in the database.
    const leak = await h.db.query(
      "SELECT count(*)::int AS n FROM interactions WHERE user_hash::text LIKE '%600000000000000000%'",
    );
    expect(leak.rows[0]?.n).toBe(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('loses no events while the collector is down for 5 minutes, and stores each exactly once', async () => {
    let down = false;
    const flaky: typeof fetch = async (input, init) => {
      if (down && String(input).endsWith('/v1/ingest')) throw new TypeError('fetch failed: connect ECONNREFUSED');
      return fetch(input, init);
    };
    const client = new ShardlensClient({
      endpoint,
      apiKey: INGEST_KEY,
      sdk: { name: '@shardlens/e2e', version: '0.0.0' },
      flushIntervalMs: 60_000,
      fetch: flaky,
      logger: { warn: () => undefined },
    });
    for (let i = 0; i < 50 && !client.ready; i++) await new Promise((r) => setTimeout(r, 20));

    vi.useFakeTimers({ toFake: ['Date'] });
    down = true;
    const sent: string[] = [];
    // 5 minutes of outage: an event every second, a flush attempt every 5 seconds.
    for (let second = 0; second < 300; second++) {
      const id = uuidv7();
      sent.push(id);
      client.enqueue({ id, ts: Date.now(), type: 'custom', name: 'outage_probe', props: { second } } as WireEvent, 2);
      if (second % 5 === 0) await client.flush();
      vi.setSystemTime(Date.now() + 1_000);
    }
    expect(client.stats().queueDepth).toBe(300);
    expect(client.stats().failedFlushes).toBeGreaterThan(0);

    down = false;
    vi.setSystemTime(Date.now() + 61_000); // past the longest backoff
    for (let i = 0; i < 5 && client.stats().queueDepth > 0; i++) await client.flush();
    await client.shutdown({ timeoutMs: 2_000 });

    const dropped = Object.values(client.stats().dropped).reduce((a, b) => a + b, 0);
    expect(dropped).toBe(0);
    const rows = await h.db.query<{ n: number; distinct_ids: number }>(
      "SELECT count(*)::int AS n, count(DISTINCT id)::int AS distinct_ids FROM custom_events WHERE name = 'outage_probe'",
    );
    expect(rows.rows[0]).toEqual({ n: 300, distinct_ids: 300 });
  });
});
