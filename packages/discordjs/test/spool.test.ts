import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { uuidv7, type WireEvent } from '@shardlens/core';
import { Guild } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CountRefresher } from '../src/guilds.js';
import { createShardlens } from '../src/index.js';
import { FileSpool } from '../src/spool.js';
import { APP_ID, currentMonth, GUILD_ID, makeDiscordClient, rawGuild, SALT_B64 } from './helpers.js';

// A read-only volume, which even root can't delete from: tests run as root in containers, where chmod doesn't stop it.
const fsFaults = vi.hoisted(() => ({ readOnly: false }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...fs,
    unlink: (path: Parameters<typeof fs.unlink>[0]) =>
      fsFaults.readOnly
        ? Promise.reject(Object.assign(new Error('read-only file system'), { code: 'EROFS' }))
        : fs.unlink(path),
  };
});

const dirs: string[] = [];
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'shardlens-spool-'));
  dirs.push(dir);
  return dir;
}

const ev = (name = 'ticket_opened') => ({ id: uuidv7(), ts: Date.now(), type: 'custom', name, props: {} }) as WireEvent;

describe('FileSpool', () => {
  it('stores batches oldest first and deletes them on ack', async () => {
    const dir = tempDir();
    const spool = new FileSpool(join(dir, 'spool'));
    await spool.write([ev('first'), ev('first')]);
    await spool.write([ev('second')]);
    const one = await spool.next();
    expect(one?.events.map((e) => (e as WireEvent & { name: string }).name)).toEqual(['first', 'first']);
    await spool.ack(one?.id as string);
    const two = await spool.next();
    expect(two?.events).toHaveLength(1);
    await spool.ack(two?.id as string);
    expect(await spool.next()).toBeUndefined();
  });

  it('survives a new instance (a restart) and skips a torn last line', async () => {
    const dir = join(tempDir(), 'spool');
    await new FileSpool(dir).write([ev(), ev()]);
    const [file] = readdirSync(dir);
    writeFileSync(join(dir, file as string), `${readFileSync(join(dir, file as string), 'utf8')}{"id":"partial`);
    const batch = await new FileSpool(dir).next();
    expect(batch?.events).toHaveLength(2);
  });

  it('evicts the oldest batches to stay under its size cap', async () => {
    const dir = join(tempDir(), 'spool');
    const spool = new FileSpool(dir, 2048);
    for (let i = 0; i < 20; i++) await spool.write([ev(`batch_${i}`)]);
    const total = readdirSync(dir).reduce((n, f) => n + statSync(join(dir, f)).size, 0);
    expect(total).toBeLessThanOrEqual(2048);
    const oldest = await spool.next();
    expect(oldest).toBeDefined();
    expect((oldest?.events[0] as (WireEvent & { name: string }) | undefined)?.name).not.toBe('batch_0');
  });

  it('reports how many unsent events each eviction lost', async () => {
    const dir = join(tempDir(), 'spool');
    let evicted = 0;
    const spool = new FileSpool(dir, 2048, (events) => {
      evicted += events;
    });
    for (let i = 0; i < 20; i++) await spool.write([ev(`batch_${i}`), ev(`batch_${i}`)]);
    let left = 0;
    for (let batch = await spool.next(); batch; batch = await spool.next()) {
      left += batch.events.length;
      await spool.ack(batch.id);
    }
    expect(evicted).toBeGreaterThan(0);
    expect(evicted + left).toBe(40);
  });

  it('never lets two processes sharing a folder replace each other’s batches', async () => {
    const dir = join(tempDir(), 'spool');
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_763_052_121_000);
    try {
      await Promise.all([new FileSpool(dir).write([ev('a')]), new FileSpool(dir).write([ev('b')])]);
    } finally {
      now.mockRestore();
    }
    expect(readdirSync(dir)).toHaveLength(2);
  });

  it('keeps the default size cap when maxBytes is not a number', async () => {
    const dir = join(tempDir(), 'spool');
    const spool = new FileSpool(dir, Number.NaN);
    await spool.write([ev('first')]);
    await spool.write([ev('second')]);
    expect(readdirSync(dir)).toHaveLength(2);
  });

  it('stays under its cap, and evicts only when really full, with several processes on one folder', async () => {
    const dir = join(tempDir(), 'spool');
    const processes = Array.from({ length: 8 }, () => new FileSpool(dir, 10_000));
    const total = () => readdirSync(dir).reduce((n, f) => n + statSync(join(dir, f)).size, 0);
    for (let round = 0; round < 10; round++) {
      for (const spool of processes) await spool.write([ev(`p_${round}`), ev(`p_${round}`)]);
    }
    expect(total()).toBeLessThanOrEqual(10_000);

    // One process replays (and deletes) most of the folder; another, which counted it full, must not evict now.
    const [a, b] = processes as [FileSpool, FileSpool];
    for (let i = 0; i < readdirSync(dir).length - 1; i++) {
      const batch = await a.next();
      if (batch) await a.ack(batch.id);
    }
    const left = new Set(readdirSync(dir));
    await b.write([ev('fresh')]);
    for (const name of left) expect(readdirSync(dir)).toContain(name);
  });

  it("never hands out a segment again once accepted, even when it can't be deleted", async () => {
    const dir = join(tempDir(), 'spool');
    const spool = new FileSpool(dir);
    await spool.write([ev('first')]);
    await spool.write([ev('second')]);
    const first = await spool.next();
    fsFaults.readOnly = true; // the segment stays on disk
    try {
      await expect(spool.ack(first?.id as string)).rejects.toThrow('read-only');
      const next = await spool.next();
      expect(next?.id).not.toBe(first?.id);
      expect((next?.events[0] as (WireEvent & { name: string }) | undefined)?.name).toBe('second');
    } finally {
      fsFaults.readOnly = false;
    }
  });

  it('cleans up temp files a failed write or a crash left behind', async () => {
    const dir = join(tempDir(), 'spool');
    await new FileSpool(dir).write([ev()]);
    const orphan = join(dir, 'seg-0000000000001-000001.ndjson.tmp');
    writeFileSync(orphan, '{"partial');
    utimesSync(orphan, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
    const fresh = join(dir, 'seg-0000000000002-000002.ndjson.tmp');
    writeFileSync(fresh, '{"being written');
    await new FileSpool(dir).next();
    expect(readdirSync(dir)).not.toContain('seg-0000000000001-000001.ndjson.tmp');
    expect(readdirSync(dir)).toContain('seg-0000000000002-000002.ndjson.tmp');
  });

  it('removes the events a predicate picks, such as an erased user', async () => {
    const dir = join(tempDir(), 'spool');
    const spool = new FileSpool(dir);
    await spool.write([{ ...ev('gone'), user: 'h1:x:a' } as WireEvent, ev('kept')]);
    await spool.write([{ ...ev('gone'), user: 'h1:x:a' } as WireEvent]);
    expect(await spool.drop((e) => (e as WireEvent & { user?: string }).user === 'h1:x:a')).toBe(2);
    const batch = await spool.next();
    expect(batch?.events.map((e) => (e as WireEvent & { name: string }).name)).toEqual(['kept']);
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it('only ever deletes its own segment files', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'keep.txt'), 'not ours');
    const spool = new FileSpool(join(dir, 'spool'));
    await spool.ack('../keep.txt');
    await spool.ack('seg-../../keep.txt');
    expect(readdirSync(dir)).toContain('keep.txt');
  });
});

describe('disk spool end to end', () => {
  /** A collector that is down until `up()`, then stores events by ID. */
  async function flakyCollector() {
    let up = false;
    const stored = new Set<string>();
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        if (req.url === '/v1/config') {
          res.writeHead(200, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              v: 1,
              appId: APP_ID,
              mode: 'privacy',
              saltPeriod: 'month',
              salts: [{ period: currentMonth(), salt: SALT_B64 }],
              sampling: {},
              serverTime: new Date().toISOString(),
            }),
          );
          return;
        }
        if (!up) {
          res.writeHead(503, { 'retry-after': '60' }).end();
          return;
        }
        const body = JSON.parse(gunzipSync(Buffer.concat(chunks)).toString('utf8')) as { events: WireEvent[] };
        for (const e of body.events) if (e.type !== 'sdk_health') stored.add(e.id);
        res.writeHead(202, { 'content-type': 'application/json' }).end('{"accepted":1,"duplicates":0,"rejected":[]}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    cleanup.push(
      () =>
        new Promise<void>((r) => {
          server.closeAllConnections();
          server.close(() => r());
        }),
    );
    return {
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      stored,
      up: () => {
        up = true;
      },
    };
  }

  async function bot(url: string, dir: string, limits: { maxBytes?: number; maxBatchSize?: number } = {}) {
    const { client } = makeDiscordClient(() => new Response(null, { status: 204 }));
    const lens = createShardlens(client, {
      endpoint: url,
      apiKey: 'slk_ingest_spool',
      flushIntervalMs: 60_000,
      disable: ['process'],
      spool: { dir, maxBytes: limits.maxBytes },
      maxBatchSize: limits.maxBatchSize,
      logger: { warn: () => undefined },
    });
    for (let i = 0; i < 50 && !lens.client.ready; i++) await new Promise((r) => setTimeout(r, 10));
    return { client, lens };
  }

  it('keeps events through an outage and a bot restart, then delivers them once', async () => {
    const collector = await flakyCollector();
    const dir = join(tempDir(), 'spool');

    // The collector is down; the bot records events and shuts down.
    const first = await bot(collector.url, dir);
    for (let i = 0; i < 20; i++) first.lens.track('ticket_opened', { i });
    await first.lens.flush();
    await first.lens.shutdown({ timeoutMs: 500 });
    first.client.removeAllListeners();
    expect(readdirSync(dir).length).toBeGreaterThan(0);
    expect(collector.stored.size).toBe(0);

    // The bot restarts; the collector is back. Spooled events go first, and the spool empties.
    collector.up();
    const second = await bot(collector.url, dir);
    second.lens.track('after_restart');
    await second.lens.flush();
    await second.lens.shutdown({ timeoutMs: 500 });
    second.client.removeAllListeners();
    expect(collector.stored.size).toBe(21);
    expect(readdirSync(dir)).toEqual([]);
    expect(second.lens.stats().replayed).toBe(20);
  });

  it('counts what the spool evicts at its size cap as dropped', async () => {
    const collector = await flakyCollector();
    const dir = join(tempDir(), 'spool');
    const { client, lens } = await bot(collector.url, dir, { maxBytes: 1024, maxBatchSize: 5 });
    for (let i = 0; i < 60; i++) lens.track('ticket_opened', { i });
    await lens.flush();
    await lens.shutdown({ timeoutMs: 500 });
    client.removeAllListeners();

    let onDisk = 0;
    const spool = new FileSpool(dir, 1024);
    for (let batch = await spool.next(); batch; batch = await spool.next()) {
      onDisk += batch.events.length;
      await spool.ack(batch.id);
    }
    const stats = lens.stats();
    expect(stats.dropped.spool_evicted).toBeGreaterThan(0);
    expect(stats.spooled).toBe(onDisk + (stats.dropped.spool_evicted ?? 0));
    expect(stats.internalErrors.spool_evicted).toBeGreaterThan(0);
  });
});

describe('refreshGuildCounts', () => {
  it('refreshes approximate member counts one server at a time, never reading presences', async () => {
    const urls: string[] = [];
    const { client } = makeDiscordClient((url) => {
      urls.push(url);
      return Response.json({
        ...rawGuild(),
        approximate_member_count: 1234,
        // Long enough that it can't turn up by chance in the event's ID or timestamp.
        approximate_presence_count: 987_654_321_987,
      });
    });
    const guild = Reflect.construct(Guild, [client, rawGuild()]) as Guild;
    client.guilds.cache.set(GUILD_ID, guild);
    const refresher = new CountRefresher();
    const event = await refresher.next(client);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain(`/guilds/${GUILD_ID}`);
    expect(urls[0]).toContain('with_counts=true');
    expect(event).toMatchObject({ type: 'guild_update', info: { guild: GUILD_ID, memberCount: 1234 } });
    expect(JSON.stringify(event)).not.toContain('987654321987');
    client.removeAllListeners();
  });
});
