import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gunzipSync } from 'node:zlib';
import { ChatInputCommandInteraction, type Client, Events } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createShardlens, type Shardlens } from '../src/index.js';
import { APP_ID, currentMonth, makeDiscordClient, rawSlashCommand, SALT_B64, settle, snowflake } from './helpers.js';

type Behaviour = 'ok' | 'hang' | 'error500' | 'ratelimit' | 'kill-after-store';

/**
 * A real HTTP collector that can misbehave on demand. It stores events by ID (like the real collector's
 * `ON CONFLICT DO NOTHING`), so duplicates from retries are visible as `deliveries > stored`.
 */
async function chaosCollector() {
  let behaviour: Behaviour = 'ok';
  const stored = new Set<string>();
  let deliveries = 0;
  const hanging: ServerResponse[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.url === '/v1/config') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
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
      if (behaviour === 'hang') {
        hanging.push(res);
        return;
      }
      if (behaviour === 'error500') {
        res.writeHead(500).end();
        return;
      }
      if (behaviour === 'ratelimit') {
        res.writeHead(429, { 'retry-after': '2' }).end();
        return;
      }
      const body = JSON.parse(gunzipSync(Buffer.concat(chunks)).toString('utf8')) as {
        events: { id: string; type: string }[];
      };
      for (const e of body.events) {
        if (e.type === 'sdk_health') continue;
        deliveries++;
        stored.add(e.id);
      }
      if (behaviour === 'kill-after-store') {
        req.socket.destroy(); // stored, but the SDK never hears back: it must retry, and the retry must not double count
        return;
      }
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ accepted: body.events.length, duplicates: 0, rejected: [] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    stored,
    get deliveries() {
      return deliveries;
    },
    set(b: Behaviour) {
      behaviour = b;
    },
    async close() {
      for (const res of hanging) res.destroy();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function setup(maxQueueSize = 10_000) {
  const collector = await chaosCollector();
  const { client } = makeDiscordClient(() => new Response(null, { status: 204 }));
  const lens: Shardlens = createShardlens(client, {
    endpoint: collector.url,
    apiKey: 'slk_ingest_chaos',
    flushIntervalMs: 60_000,
    maxQueueSize,
    disable: ['process'],
    logger: { warn: () => undefined },
  });
  cleanup.push(() => collector.close());
  cleanup.push(() => lens.shutdown({ timeoutMs: 10 }));
  cleanup.push(() => {
    (client as Client).removeAllListeners();
  });
  for (let i = 0; i < 50 && !lens.client.ready; i++) await new Promise((r) => setTimeout(r, 10));
  return { collector, client, lens };
}

function command(client: Client, i: number) {
  return Reflect.construct(ChatInputCommandInteraction, [
    client,
    rawSlashCommand({ id: snowflake(Date.now(), i) }),
  ]) as ChatInputCommandInteraction;
}

describe('chaos: the bot keeps answering whatever the collector does', () => {
  for (const behaviour of ['hang', 'error500', 'ratelimit'] as const) {
    it(`answers interactions well within 3 s while the collector is ${behaviour}`, async () => {
      const { collector, client, lens } = await setup();
      collector.set(behaviour);
      for (let i = 0; i < 50; i++) lens.track('filler', { i });
      void lens.flush(); // a flush is now stuck or failing in the background
      const slowest = { ms: 0 };
      for (let i = 0; i < 25; i++) {
        const interaction = command(client, i);
        const started = performance.now();
        client.emit(Events.InteractionCreate, interaction);
        await interaction.reply({ content: 'pong' });
        slowest.ms = Math.max(slowest.ms, performance.now() - started);
      }
      expect(slowest.ms).toBeLessThan(250);
      // Shutdown gives up at its deadline instead of hanging the bot's exit.
      const t = performance.now();
      await lens.shutdown({ timeoutMs: 300 });
      expect(performance.now() - t).toBeLessThan(2_000);
    });
  }

  it('keeps memory bounded when the collector is down: the queue never exceeds its cap and drops are counted', async () => {
    const { collector, lens } = await setup(2_000);
    collector.set('error500');
    for (let i = 0; i < 6_000; i++) lens.track('flood', { i });
    await lens.flush();
    const stats = lens.stats();
    expect(stats.queueDepth).toBeLessThanOrEqual(2_000);
    expect(Object.values(stats.dropped).reduce((a, b) => a + b, 0)).toBe(4_000);
  });

  it('stores every event exactly once when the collector is killed mid-flush and then recovers', async () => {
    const { collector, lens } = await setup();
    vi.useFakeTimers({ toFake: ['Date'] });
    const ids = new Set<string>();
    lens.client.on('error', () => undefined);
    for (let i = 0; i < 300; i++) lens.track('kill_probe', { i });
    collector.set('kill-after-store');
    await lens.flush(); // the collector stores the batch, then the connection dies
    collector.set('ok');
    vi.setSystemTime(Date.now() + 61_000);
    for (let i = 0; i < 5 && lens.stats().queueDepth > 0; i++) await lens.flush();
    await settle();
    expect(lens.stats().queueDepth).toBe(0);
    for (const id of collector.stored) ids.add(id);
    expect(ids.size).toBe(300);
    expect(collector.deliveries).toBeGreaterThan(300); // retried: the same IDs arrived twice…
    expect(collector.stored.size).toBe(300); // …and were stored once
  });
});
