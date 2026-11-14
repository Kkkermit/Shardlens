import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShardlensClient, uuidv7, type WireEvent } from '@shardlens/core';
import { afterAll, describe, expect, it } from 'vitest';
import { type EmbeddedCollector, startEmbeddedCollector } from '../src/embedded.js';

const APP_ID = '1234567890123456789';
const dataDir = mkdtempSync(join(tmpdir(), 'shardlens-embedded-'));
let collector: EmbeddedCollector | undefined;

afterAll(async () => {
  await collector?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function query(c: EmbeddedCollector, spec: object) {
  const res = await fetch(`${c.url}/v1/query`, {
    method: 'POST',
    headers: { authorization: `Bearer ${c.readKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(spec),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const range = () => ({
  from: new Date(Date.now() - 3_600_000).toISOString(),
  to: new Date(Date.now() + 60_000).toISOString(),
});

describe('embedded collector (PGlite)', () => {
  it(
    'starts in a folder, accepts batches from the real SDK client and answers queries',
    {
      timeout: 60_000,
    },
    async () => {
      collector = await startEmbeddedCollector({ dataDir, appId: APP_ID, port: 0, logLevel: 'silent' });
      expect(collector.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(collector.ingestKey).toMatch(/^slk_ingest_[\w-]{43}$/);
      expect(existsSync(join(dataDir, 'secrets.json'))).toBe(true);
      expect((await fetch(`${collector.url}/readyz`)).status).toBe(200);

      const client = new ShardlensClient({
        endpoint: collector.url,
        apiKey: collector.ingestKey,
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
    expect(collector.ingestKey).toBe(before.ingestKey);
    expect(collector.readKey).toBe(before.readKey);
    const events = await query(collector, { kind: 'events', range: range() });
    expect(events.body.rows).toEqual([expect.objectContaining({ name: 'ticket_opened', count: 2 })]);
  });

  it('refuses requests without a key, like the standalone collector', async () => {
    const res = await fetch(`${(collector as EmbeddedCollector).url}/v1/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'events', range: range() }),
    });
    expect(res.status).toBe(401);
  });
});
