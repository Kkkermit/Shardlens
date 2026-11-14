// SDK overhead: event-loop CPU per interaction and memory at a full buffer, against the built package with a real
// discord.js Client and no network. Exits non-zero when a target is missed, so CI can gate on it.
import { ChatInputCommandInteraction, Client, Events, GatewayIntentBits, RESTEvents } from 'discord.js';
import { Bench } from 'tinybench';
import { createShardlens } from '../dist/index.js';

const TARGET_CPU_US = 50;
const TARGET_HEAP_MB = 15;
const QUEUE = 10_000;
const APP_ID = '1234567890123456789';
const SALT = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';

const month = () => new Date().toISOString().slice(0, 7);
const fakeFetch = async (input) =>
  String(input).endsWith('/v1/config')
    ? Response.json({
        v: 1,
        appId: APP_ID,
        mode: 'privacy',
        saltPeriod: 'month',
        salts: [{ period: month(), salt: SALT }],
        sampling: {},
        serverTime: new Date().toISOString(),
      })
    : Response.json({ accepted: 0, duplicates: 0, rejected: [] }, { status: 202 });

let seq = 0;
const snowflake = () => (((BigInt(Date.now()) - 1420070400000n) << 22n) + BigInt(seq++ % 4_000_000)).toString();

function raw() {
  return {
    id: snowflake(),
    application_id: APP_ID,
    type: 2,
    token: `aW50ZXJhY3Rpb246${'x'.repeat(60)}`,
    version: 1,
    locale: 'en-GB',
    guild_locale: 'en-US',
    guild_id: '112233445566778899',
    channel_id: '223344556677889900',
    app_permissions: '0',
    entitlements: [],
    authorizing_integration_owners: { 0: '112233445566778899' },
    context: 0,
    member: {
      user: {
        id: String(300000000000000000n + BigInt(seq % 5000)),
        username: 'u',
        discriminator: '0',
        global_name: null,
        avatar: null,
      },
      roles: [],
      permissions: '0',
      joined_at: '2020-01-01T00:00:00.000Z',
      deaf: false,
      mute: false,
      flags: 0,
    },
    data: {
      id: '445566778899001122',
      name: 'ticket',
      type: 1,
      options: [{ type: 1, name: 'open', options: [{ type: 3, name: 'category', value: 'billing' }] }],
    },
  };
}

/** The memory run keeps the collector "down" so the queue fills up instead of draining. */
const downFetch = async (input, init) => {
  if (String(input).endsWith('/v1/config')) return fakeFetch(input, init);
  throw new TypeError('collector down');
};

function setup(maxQueueSize, fetchImpl = fakeFetch) {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const lens = createShardlens(client, {
    endpoint: 'https://collector.test',
    apiKey: 'slk_ingest_bench',
    fetch: fetchImpl,
    flushIntervalMs: 3_600_000,
    maxQueueSize,
    disable: ['process'],
    logger: { warn: () => undefined },
  });
  return { client, lens };
}

/** The REST `response` event discord.js emits for an interaction's first reply (undici-style response). */
function callbackResponse(interaction) {
  return [
    {
      method: 'POST',
      path: `/interactions/${interaction.id}/${interaction.token}/callback`,
      route: '/interactions/:id/:token/callback',
      options: { headers: {} },
      data: { body: { type: 4, data: { content: 'ok' } } },
      retries: 0,
    },
    { status: 204, ok: true, headers: new Headers(), body: null, bodyUsed: false },
  ];
}

const settle = () => new Promise((r) => setImmediate(r));
const waitReady = async (lens) => {
  for (let i = 0; i < 200 && !lens.client.ready; i++) await new Promise((r) => setTimeout(r, 5));
};

const { client, lens } = setup(QUEUE);
await waitReady(lens);
const pool = Array.from({ length: 50_000 }, () => Reflect.construct(ChatInputCommandInteraction, [client, raw()]));
let next = 0;

const bench = new Bench({ time: 1_500, warmup: true });
bench
  .add('interactionCreate listener (sync, event loop)', () => {
    client.emit(Events.InteractionCreate, pool[next++ % pool.length]);
  })
  .add('first response → event queued (incl. HMAC)', async () => {
    const i = pool[next++ % pool.length];
    client.emit(Events.InteractionCreate, i);
    client.rest.emit(RESTEvents.Response, ...callbackResponse(i));
    await settle();
  });
await bench.run();
const rows = bench.tasks.map((t) => ({
  task: t.name,
  'mean µs': Number((t.result.latency.mean * 1000).toFixed(2)),
  'p99 µs': Number((t.result.latency.p99 * 1000).toFixed(2)),
  'ops/s': Math.round(t.result.throughput?.mean ?? 0),
}));
console.table(rows);

// Event-loop CPU for a whole lifecycle, measured with process.cpuUsage (user + system).
const N = 5_000;
const before = process.cpuUsage();
for (let k = 0; k < N; k++) {
  const i = pool[next++ % pool.length];
  client.emit(Events.InteractionCreate, i);
  client.rest.emit(RESTEvents.Response, ...callbackResponse(i));
  if (k % 100 === 0) await settle();
}
await settle();
const cpu = process.cpuUsage(before);
const cpuPerInteraction = (cpu.user + cpu.system) / N;
await lens.shutdown({ timeoutMs: 10 });
client.removeAllListeners();

// Memory at a full 10,000-event buffer
globalThis.gc?.();
const heapBefore = process.memoryUsage().heapUsed;
const mem = setup(QUEUE, downFetch);
await waitReady(mem.lens);
for (let k = 0; k < QUEUE + 500; k++) {
  const i = Reflect.construct(ChatInputCommandInteraction, [mem.client, raw()]);
  mem.client.emit(Events.InteractionCreate, i);
  mem.client.rest.emit(RESTEvents.Response, ...callbackResponse(i));
  if (k % 200 === 0) await settle();
}
for (let k = 0; k < 20; k++) await settle();
globalThis.gc?.();
const heapMb = (process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024;
const depth = mem.lens.stats().queueDepth;
await mem.lens.shutdown({ timeoutMs: 10 });

console.log(`CPU per interaction (whole lifecycle): ${cpuPerInteraction.toFixed(1)} µs (target < ${TARGET_CPU_US} µs)`);
console.log(`Heap at a full buffer (${depth} events): ${heapMb.toFixed(1)} MB (target < ${TARGET_HEAP_MB} MB)`);
if (!globalThis.gc) console.log('(run with --expose-gc for a precise heap figure)');

const failed = cpuPerInteraction >= TARGET_CPU_US || heapMb >= TARGET_HEAP_MB || depth < QUEUE * 0.99;
process.exit(failed ? 1 : 0);
