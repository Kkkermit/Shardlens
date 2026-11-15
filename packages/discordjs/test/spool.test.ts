import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

  async function bot(url: string, dir: string) {
    const { client } = makeDiscordClient(() => new Response(null, { status: 204 }));
    const lens = createShardlens(client, {
      endpoint: url,
      apiKey: 'slk_ingest_spool',
      flushIntervalMs: 60_000,
      disable: ['process'],
      spool: { dir },
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
