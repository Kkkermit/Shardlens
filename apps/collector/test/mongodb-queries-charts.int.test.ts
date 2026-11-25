import { UserHasher, uuidv7 } from '@shardlens/core';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { jsonText, roundTenths } from '../src/storage/mongodb/query/pg-values.js';
import { realRatio } from '../src/storage/mongodb/query/real-sums.js';
import { periodBounds, periodLabel } from '../src/storage/periods.js';
import { ensureSalt } from '../src/storage/salts.js';
import type { Store } from '../src/storage/store.js';
import {
  APP_ID,
  envelope,
  guildInfo,
  type Harness,
  ingest,
  mongoStore,
  postgresStore,
  READ_KEY,
  startHarness,
} from './harness.js';

/*
 * The query kinds MongoDB answers in `storage/mongodb/query/{charts,commands,overview,funnels}.ts`, asked of a
 * PostgreSQL collector and a MongoDB one holding the same 88 days of events. Each answer must be the same JSON. Events
 * are ingested over HTTP at the time they happened (a fake clock), then rolled up, so charts read minute, hourly and
 * daily rollups and single events as they would in a running collector. Where PostgreSQL leaves an order undefined
 * (rows with equal values), the answers are compared with those rows in a fixed order. Weights are whole numbers and
 * halves: PostgreSQL sums them as `real` in the order it reads them, which other fractions would make differ in the
 * last bits.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/**
 * The collectors' clock while they ingest and answer (a fake one): fixed, so that both read the same windows and the
 * 88 days before it hold a DST change in each zone below that has one.
 */
const NOW = Date.parse('2026-11-25T12:00:00Z');
const DATA_DAYS = 88;
const ZONES = ['UTC', 'America/New_York', 'Europe/London', 'Australia/Lord_Howe', 'Asia/Kolkata'] as const;
// DST changes inside the data: Lord Howe forward half an hour, London and New York back an hour.
const LORD_HOWE_FORWARD = Date.parse('2026-10-03T15:30:00Z');
const LONDON_BACK = Date.parse('2026-10-25T01:00:00Z');
const NEW_YORK_BACK = Date.parse('2026-11-01T06:00:00Z');

const GUILDS = ['112233445566778899', '223344556677889900', '334455667788990011', '445566778899001122'];
/** Ran commands, but the bot never reported it, so it has no name. */
const UNNAMED_GUILD = '556677889900112233';
const USERS = Array.from({ length: 36 }, (_, i) => String(400000000000000000n + BigInt(i)));
const LOCALES = ['en-GB', 'en-US', 'de', 'fr', 'pt-BR', 'ja'];
const WEIGHTS = [1, 1, 1, 1, 2, 4, 1.5, 2.5];

/** A seeded generator, so a failure can be replayed. */
function random(seed: number) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T;
  return { next, pick, chance: (p: number) => next() < p };
}

/** An event to send to both collectors: `userId` is hashed with each one's own salt for the event's period. */
interface Template {
  id: string;
  ts: number;
  type: string;
  userId?: string | undefined;
  [field: string]: unknown;
}

const COMMANDS = [
  { name: 'ticket', kind: 'chat_input', subs: ['open', 'close'], share: 30 },
  { name: 'config', kind: 'chat_input', group: 'set', subs: ['colour', 'language'], share: 12 },
  { name: 'ping', kind: 'chat_input', share: 20 },
  { name: 'stats', kind: 'chat_input', share: 9 },
  { name: 'Report User', kind: 'user_context', share: 5 },
  { name: 'Translate', kind: 'message_context', share: 4 },
  { name: 'launch', kind: 'primary_entry_point', share: 2 },
  { name: 'ban', kind: 'chat_input', share: 6 },
] as const;

function templates(): Template[] {
  const r = random(0x5eed);
  const out: Template[] = [];
  const at = (ts: number) => Math.round(ts);
  const when = () => {
    const x = r.next();
    if (x < 0.4) return NOW - 5 * MINUTE - r.next() * (DATA_DAYS - 1) * DAY;
    if (x < 0.7) return NOW - 5 * MINUTE - r.next() * 14 * DAY;
    if (x < 0.85) return NOW - 5 * MINUTE - r.next() * 2 * DAY;
    return r.pick([LORD_HOWE_FORWARD, LONDON_BACK, NEW_YORK_BACK]) + (r.next() - 0.5) * 6 * HOUR;
  };
  const totalShare = COMMANDS.reduce((a, c) => a + c.share, 0);
  const command = () => {
    let x = r.next() * totalShare;
    for (const c of COMMANDS) {
      x -= c.share;
      if (x < 0) return c;
    }
    return COMMANDS[0];
  };
  const optionValues = () =>
    r.pick([
      undefined,
      { category: r.pick(['billing', 'support', 'bug']) },
      { category: 'billing', priority: r.pick([1, 2, 3]), urgent: r.chance(0.5) },
      { ratio: r.pick([0.1, 2.5, 1e21, 1e-7, -3, 1e16, 0.000001, 123456.789]) },
    ]);

  for (let i = 0; i < 2600; i++) {
    const ts = at(when());
    const c = command();
    const userId = r.pick(USERS);
    const guild = r.chance(0.12) ? undefined : r.chance(0.08) ? UNNAMED_GUILD : r.pick(GUILDS);
    const outcome = r.pick(['ok', 'ok', 'ok', 'ok', 'ok', 'error', 'timeout', 'no_response'] as const);
    const ackMs =
      outcome === 'no_response' || r.chance(0.05)
        ? undefined
        : r.pick([0, 1, 2, 3001, 60_000, 90_000, Math.floor(r.next() * 4_000)]);
    const base = {
      ts,
      userId,
      weight: r.pick(WEIGHTS),
      guild,
      channelType: guild ? r.pick([0, 2, 5, 11]) : r.pick([1, undefined]),
      memberTier: guild
        ? r.pick(['admin', 'manager', 'member', undefined] as const)
        : r.pick(['dm', undefined] as const),
      handlerMs: r.chance(0.8) ? Math.floor(r.next() * 2_500) : undefined,
      shard: guild ? 0 : undefined,
    };
    if (c.name === 'ban' && r.chance(0.4)) {
      out.push({
        id: uuidv7(ts),
        type: 'message_command',
        command: r.pick(['ban', 'warn']),
        options: r.chance(0.5) ? ['user'] : [],
        optionValues: r.chance(0.3) ? { reason: r.pick(['spam', 'raid']) } : undefined,
        outcome: r.pick(['ok', 'ok', 'error'] as const),
        errorClass: undefined,
        ...base,
      });
      continue;
    }
    const sub = 'subs' in c ? r.pick([...c.subs, undefined]) : undefined;
    const id = uuidv7(ts);
    const opensModal = (c.name === 'ticket' || c.name === 'config') && r.chance(0.15);
    out.push({
      id,
      type: 'interaction',
      kind: c.kind,
      command: c.name,
      group: 'group' in c && sub ? c.group : undefined,
      sub,
      options: r.pick([[], ['category'], ['category', 'priority'], ['category', 'category']]),
      optionValues: optionValues(),
      context: guild ? 0 : r.pick([1, 2, undefined] as const),
      install: r.pick(['guild', 'user', 'both', undefined] as const),
      locale: r.pick(LOCALES),
      premium: r.chance(0.2),
      outcome,
      errorCode: outcome === 'error' ? r.pick([10062, 50013, undefined]) : undefined,
      errorClass: outcome === 'error' ? r.pick(['TypeError', 'DiscordAPIError']) : undefined,
      ackMs,
      responseType: opensModal ? 9 : r.pick([4, 5, undefined]),
      customId: opensModal ? `${c.name}:modal` : undefined,
      deferred: r.pick([true, false, undefined]),
      ephemeral: r.pick([true, false, undefined]),
      ...base,
    });
    if (opensModal && r.chance(0.6)) {
      const later = ts + Math.floor(r.next() * 5 * MINUTE);
      out.push({
        id: uuidv7(later),
        type: 'interaction',
        kind: 'modal_submit',
        customId: `${c.name}:modal`,
        options: [],
        locale: r.pick(LOCALES),
        premium: false,
        outcome: r.pick(['ok', 'ok', 'error'] as const),
        ackMs: Math.floor(r.next() * 900),
        ...base,
        ts: later,
      });
    }
    if (outcome === 'error' && r.chance(0.5)) {
      out.push({
        id: uuidv7(ts + 500),
        ts: ts + 500,
        type: 'interaction_error',
        interaction: id,
        command: c.name,
        errorClass: r.pick(['RangeError', 'TypeError']),
        errorCode: r.pick([10008, undefined]),
        handlerMs: Math.floor(r.next() * 300),
        weight: base.weight,
      });
    }
  }
  // Buttons, menus and autocomplete.
  for (let i = 0; i < 500; i++) {
    const ts = at(when());
    const autocomplete = r.chance(0.3);
    const guild = r.chance(0.2) ? undefined : r.pick(GUILDS);
    out.push({
      id: uuidv7(ts),
      ts,
      type: 'interaction',
      kind: autocomplete ? 'autocomplete' : r.pick(['button', 'select'] as const),
      command: autocomplete ? r.pick(['ticket', 'config']) : undefined,
      options: autocomplete ? [r.pick(['category', 'priority'])] : [],
      customId: autocomplete ? undefined : r.pick(['ticket:close:*', 'ticket:claim', 'menu:pick', undefined]),
      sourceCommand: autocomplete ? undefined : r.pick(['ticket', 'config', undefined]),
      componentType: autocomplete ? undefined : r.pick([2, 3]),
      guild,
      locale: r.pick(LOCALES),
      userId: r.pick(USERS),
      premium: false,
      outcome: r.pick(['ok', 'ok', 'ok', 'error'] as const),
      ackMs: r.chance(0.9) ? Math.floor(r.next() * 2_000) : undefined,
      weight: r.pick(WEIGHTS),
    });
  }
  // Two commands with the same runs, whose names order differently by UTF-16 than by byte.
  for (const name of ['🎲roll', 'ｆｕｌｌ']) {
    for (const hours of [3, 4, 5]) {
      out.push({
        id: uuidv7(NOW - hours * HOUR),
        ts: NOW - hours * HOUR,
        type: 'interaction',
        kind: 'chat_input',
        command: name,
        options: [],
        guild: GUILDS[0],
        locale: 'en-GB',
        userId: USERS[hours],
        premium: false,
        outcome: 'ok',
        ackMs: 40 * hours,
      });
    }
  }
  // A prefix command named like a field, which a pipeline must read as text.
  for (const hours of [6, 30, 300]) {
    const ts = NOW - hours * HOUR;
    out.push({
      id: uuidv7(ts),
      ts,
      type: 'message_command',
      command: '$weight',
      options: [],
      userId: USERS[1],
      outcome: 'ok',
      weight: 2,
    });
  }
  // Custom events: journeys for funnels, and properties of every JSON type.
  const props = () =>
    r.pick([
      {},
      { category: r.pick(['billing', 'support']) },
      { category: 'billing', priority: r.pick([1, 2, 3]), vip: r.chance(0.5), note: null },
      { amount: r.pick([0.1, 2.5, 10, 1e21, 1e-7, -3, 1e16, 0.000001]), 'a.b': 'dotted', $x: r.pick(['dollar', 1]) },
      { priority: '2' },
    ]);
  for (let i = 0; i < 700; i++) {
    const ts = at(when());
    const userId = r.chance(0.1) ? undefined : r.pick(USERS);
    const name = r.pick(['ticket_opened', 'ticket_opened', 'ticket_closed', 'signup', 'purchase', 'level_up']);
    out.push({
      id: uuidv7(ts),
      ts,
      type: 'custom',
      name,
      props: props(),
      userId,
      guild: r.pick([...GUILDS, undefined]),
      weight: r.pick(WEIGHTS),
    });
    if (name === 'ticket_opened' && userId && r.chance(0.6)) {
      const closed = ts + Math.floor(r.next() * r.pick([HOUR, 30 * HOUR, 200 * HOUR]));
      if (closed < NOW - MINUTE) {
        out.push({
          id: uuidv7(closed),
          ts: closed,
          type: 'custom',
          name: 'ticket_closed',
          props: { resolved: r.chance(0.7) },
          userId,
          weight: 1,
        });
      }
    }
  }
  // REST, rate limits and server events, for the other chart metrics.
  for (let i = 0; i < 300; i++) {
    const ts = at(when());
    const latency = new Array<number>(40).fill(0);
    latency[Math.floor(r.next() * 40)] = 1 + Math.floor(r.next() * 20);
    latency[Math.floor(r.next() * 40)]! += Math.floor(r.next() * 5);
    out.push({
      id: uuidv7(ts),
      ts,
      type: 'rest_window',
      windowMs: 60_000,
      rows: [
        {
          method: 'POST',
          route: '/interactions/:id/:token/callback',
          status: r.pick([204, 204, 404]),
          count: 1 + Math.floor(r.next() * 9),
          retries: 0,
          latency,
        },
        {
          method: r.pick(['GET', 'PATCH']),
          route: '/channels/:id/messages',
          status: r.pick([200, 429, 500]),
          count: 1 + Math.floor(r.next() * 3),
          retries: Math.floor(r.next() * 2),
          latency,
        },
      ],
      invalid: {
        count401: r.pick([0, 0, 1]),
        count403: r.pick([0, 2]),
        count429: r.pick([0, 1, 3]),
        shared429: r.pick([0, 1]),
      },
      weight: r.pick([1, 2]),
    });
    if (r.chance(0.3)) {
      out.push({
        id: uuidv7(ts + 1),
        ts: ts + 1,
        type: 'rate_limit',
        scope: r.pick(['user', 'global', 'shared'] as const),
        global: false,
        route: r.pick(['/channels/:id/messages', '/guilds/:id/members']),
        method: 'POST',
        limit: 5,
        retryAfter: r.pick([250, 1200, 60_000]),
        sublimitTimeout: 0,
      });
    }
  }
  const first = NOW - (DATA_DAYS - 1) * DAY;
  GUILDS.forEach((guild, i) => {
    const ts = first + i * HOUR;
    out.push({
      id: uuidv7(ts),
      ts,
      type: 'guild_join',
      info: guildInfo(guild, { name: `Server ${i}`, icon: i % 2 ? `icon${i}` : null, joinedAt: ts }),
      detectedAtStartup: i === 3,
    });
  });
  for (let i = 0; i < 60; i++) {
    const ts = at(when());
    const guild = r.pick(GUILDS);
    out.push({ id: uuidv7(ts), ts, type: 'guild_availability', guild, available: r.chance(0.5), shard: 0 });
  }
  out.push({
    id: uuidv7(NOW - 20 * DAY),
    ts: NOW - 20 * DAY,
    type: 'guild_leave',
    guild: GUILDS[2],
    detectedAtStartup: true,
  });
  out.push({
    id: uuidv7(NOW - 30 * DAY),
    ts: NOW - 30 * DAY,
    type: 'command_registry',
    commands: [
      { id: '1100000000000000001', name: 'ticket', type: 1, subcommands: ['open', 'close'] },
      { id: '1100000000000000002', name: 'ticket', type: 1, guild: GUILDS[0] },
      { id: '1100000000000000003', name: 'legacy-stats', type: 1 },
      { id: '1100000000000000004', name: 'Report User', type: 2 },
      { id: '1100000000000000005', name: 'Translate', type: 3 },
      { id: '1100000000000000006', name: 'ban', type: 1 },
      { id: '1100000000000000007', name: 'launch', type: 4 },
    ],
  });
  out.push(
    {
      id: uuidv7(NOW - 3 * MINUTE),
      ts: NOW - 3 * MINUTE,
      type: 'app_info',
      name: 'Parity bot',
      approximateGuildCount: 4,
      approximateUserInstallCount: null,
      approximateUserAuthorizationCount: 7,
      dashboardUserIds: [],
      eventWebhooksStatus: 2,
      skus: [],
      sessionStartRemaining: 999,
      nodeVersion: 'v24.11.0',
      libVersion: '14.28.1',
    },
    {
      id: uuidv7(NOW - 3 * MINUTE),
      ts: NOW - 3 * MINUTE,
      type: 'sdk_health',
      queueDepth: 2,
      dropped: { queue_full: 1 },
      failedFlushes: 0,
      internalErrors: {},
    },
  );
  return out.sort((a, b) => a.ts - b.ts);
}

const TEMPLATES = templates();

/** Salt periods the events fall in. */
const PERIODS = [...new Set(TEMPLATES.map((t) => periodLabel('month', new Date(t.ts))))];

/** A hasher per period, holding the store's own salt for it, as the SDK holds the current one. */
async function hashers(store: Store): Promise<Map<string, UserHasher>> {
  const out = new Map<string, UserHasher>();
  for (const period of PERIODS) {
    await ensureSalt(store, APP_ID, period);
    const start = new Date(periodBounds(period)?.start ?? 0);
    const [salt] = await store.salts.alive(APP_ID, [period], start);
    if (!salt) throw new Error(`no salt for ${period}`);
    const hasher = new UserHasher();
    await hasher.setSalt(period, salt.secret);
    out.set(period, hasher);
  }
  return out;
}

/** Sends every event at the time it happened, in batches, so ingest takes each as recent. */
async function seed(h: Harness): Promise<void> {
  await h.store.apps.update(APP_ID, { rawRetentionDays: 90 });
  // PostgreSQL makes the daily partitions of the 90 days now kept.
  await h.store.jobs.ensurePartitions(new Date(NOW));
  await h.store.settings.set(APP_ID, 'required_permissions', '8192');
  const byPeriod = await hashers(h.store);
  const events = await Promise.all(
    TEMPLATES.map(async ({ userId, ...event }) => {
      if (userId === undefined) return event;
      const period = periodLabel('month', new Date(event.ts));
      return { ...event, user: await byPeriod.get(period)?.hash(userId, period) };
    }),
  );
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    for (let i = 0; i < events.length;) {
      // A batch of events no more than a day apart, sent a minute after the last of them.
      const batch = [];
      const start = events[i]?.ts ?? 0;
      while (i < events.length && batch.length < 400 && (events[i]?.ts ?? 0) - start < DAY) batch.push(events[i++]);
      vi.setSystemTime((batch.at(-1)?.ts ?? 0) + MINUTE);
      const res = await ingest(h.app, envelope(batch));
      expect(res.statusCode, res.body).toBe(202);
      expect(res.json().rejected).toEqual([]);
    }
  } finally {
    vi.useRealTimers();
  }
  await h.store.jobs.backfillRollups(new Date(NOW - 90 * DAY), new Date(NOW), new Date(NOW));
  await h.store.jobs.runUniques();
}

let pg: Harness;
let mongo: Harness;

beforeAll(async () => {
  [pg, mongo] = await Promise.all([startHarness({ store: postgresStore }), startHarness({ store: mongoStore })]);
  // One after the other: the fake clock is the process's.
  await seed(pg);
  await seed(mongo);
}, 600_000);

afterAll(async () => {
  await Promise.all([pg?.close(), mongo?.close()]);
});

let asked = 0;
/** One query, from addresses that change before the query route's rate limit is reached. */
async function ask(app: FastifyInstance, spec: object) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/query',
    headers: { authorization: `Bearer ${READ_KEY}` },
    remoteAddress: `10.0.${Math.floor(asked++ / 400) % 250}.1`,
    payload: spec,
  });
  return { status: res.statusCode, body: res.json() as unknown };
}

type Row = Record<string, unknown>;
const num = (v: unknown) => (typeof v === 'number' ? v : Number.NEGATIVE_INFINITY);
const text = (v: unknown) => (v === null || v === undefined ? '' : String(v));

/**
 * Rows PostgreSQL orders by `field` descending only, with equal ones in a fixed order. Fails when the rows are not
 * in that order at all, which no tie explains.
 */
function byValue(rows: Row[], field: string, label: string): Row[] {
  for (let i = 1; i < rows.length; i++) {
    expect(num(rows[i - 1]?.[field]) >= num(rows[i]?.[field]), `${label}: ${field} out of order`).toBe(true);
  }
  return [...rows].sort((a, b) => num(b[field]) - num(a[field]) || (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
}

/** The parts of an answer PostgreSQL gives in an undefined order, put in a fixed one. */
function canonical(kind: string, body: unknown, label: string): unknown {
  const b = body as Row;
  switch (kind) {
    case 'series': {
      const points = b.points as Row[];
      for (let i = 1; i < points.length; i++) {
        expect(text(points[i - 1]?.t) <= text(points[i]?.t), `${label}: points out of order`).toBe(true);
      }
      const sorted = [...points].sort((x, y) => (text(x.t) + text(x.key) < text(y.t) + text(y.key) ? -1 : 1));
      return { ...b, points: sorted };
    }
    case 'top':
      return { ...b, rows: byValue(b.rows as Row[], 'value', label) };
    case 'command': {
      const lists = [
        'kinds',
        'subcommands',
        'options',
        'memberTiers',
        'installs',
        'contexts',
        'channelTypes',
        'locales',
        'topServers',
        'components',
      ];
      const out: Row = { ...b };
      for (const list of lists) out[list] = byValue(b[list] as Row[], 'value', `${label} ${list}`);
      out.optionValues = byValue(b.optionValues as Row[], 'runs', `${label} optionValues`);
      out.modals = byValue(b.modals as Row[], 'shown', `${label} modals`);
      return out;
    }
    default:
      return body;
  }
}

/** Whether an answer counted anything, so a comparison of empty answers can't pass for one of figures. */
function counted(kind: string, body: unknown): boolean {
  const b = body as Row;
  const some = (list: unknown) => Array.isArray(list) && list.length > 0;
  switch (kind) {
    case 'series':
      return some(b.points);
    case 'top':
    case 'commands':
    case 'events':
      return some(b.rows);
    case 'heatmap':
      return some(b.cells);
    case 'command':
      return (b.totals as Row).runs !== null;
    case 'eventProps':
      return some(b.keys) || some(b.values);
    case 'funnel':
      return ((b.steps as Row[])[0]?.users as number) > 0;
    case 'retention':
      return some(b.cohorts);
    default:
      return true;
  }
}

/**
 * Asks both collectors each spec, frozen at {@link NOW}, and requires the same answers, and that at least `share` of
 * them counted something.
 */
async function compare(specs: Row[], share: number): Promise<void> {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  const mismatches: string[] = [];
  let withData = 0;
  try {
    for (const spec of specs) {
      const label = JSON.stringify(spec);
      const [a, b] = await Promise.all([ask(pg.app, spec), ask(mongo.app, spec)]);
      expect(a.status, `${label}: ${JSON.stringify(a.body)}`).toBe(200);
      if (counted(String(spec.kind), a.body)) withData++;
      const want = canonical(String(spec.kind), a.body, `${label} (PostgreSQL)`);
      const got = b.status === 200 ? canonical(String(spec.kind), b.body, `${label} (MongoDB)`) : b.body;
      try {
        expect(got).toEqual(want);
      } catch (error) {
        mismatches.push(`${label}\n${(error as Error).message.slice(0, 3_000)}`);
      }
    }
  } finally {
    vi.useRealTimers();
  }
  expect(mismatches.slice(0, 3).join('\n\n'), `${mismatches.length} of ${specs.length} differ`).toBe('');
  expect(withData / specs.length, `${withData} of ${specs.length} counted something`).toBeGreaterThanOrEqual(share);
}

const iso = (ms: number) => new Date(ms).toISOString();
const ago = (from: number, to = 0) => ({ from: iso(NOW - from), to: iso(NOW - to) });
const RANGES = {
  lastHour: ago(HOUR),
  partHours: ago(5 * HOUR + 17 * MINUTE + 3_000, 0),
  lastDay: ago(DAY),
  twoDays: ago(2 * DAY),
  week: ago(7 * DAY),
  month: ago(30 * DAY),
  pastMonth: ago(60 * DAY, 30 * DAY),
  quarter: ago(90 * DAY, -HOUR),
  // More than 395 days back: daily rollups.
  long: ago(400 * DAY),
  empty: ago(200 * DAY, 150 * DAY),
  londonAndNewYork: { from: '2026-10-20T00:00:00Z', to: '2026-11-19T00:00:00Z' },
  lordHowe: { from: '2026-09-20T00:00:00Z', to: '2026-10-20T00:00:00Z' },
};

/** The dimensions each metric keeps (`query/dimensions.ts`), and a stored value to filter by. */
const METRICS: Record<string, { dims: string[]; filter?: Row; latency?: boolean }> = {
  interactions: {
    dims: ['kind', 'command', 'sub', 'outcome', 'context', 'install', 'locale', 'tier', 'guild'],
    filter: { field: 'command', value: 'ticket' },
    latency: true,
  },
  'interactions.autocomplete': {
    dims: ['command', 'option'],
    filter: { field: 'option', value: 'category' },
    latency: true,
  },
  components: {
    dims: ['kind', 'custom_id', 'source', 'outcome', 'guild'],
    filter: { field: 'kind', value: 'button' },
    latency: true,
  },
  'modals.submitted': {
    dims: ['custom_id', 'outcome'],
    filter: { field: 'outcome', op: 'in', value: ['ok', 'error'] },
    latency: true,
  },
  'modals.shown': { dims: ['command', 'custom_id'] },
  'interactions.errors': { dims: ['command', 'error_class'], filter: { field: 'error_class', value: 'TypeError' } },
  'rest.calls': { dims: ['method', 'route', 'status'], filter: { field: 'status', value: '429' }, latency: true },
  'rest.invalid': { dims: ['status'], filter: { field: 'status', value: '429_shared' } },
  'rest.ratelimits': { dims: ['scope', 'route'], filter: { field: 'scope', value: 'user' } },
  'guild.joins': { dims: ['detected'], filter: { field: 'detected', value: 'true' } },
  'guild.unavailable': { dims: ['detected'] },
};

describe("PostgreSQL's arithmetic, as MongoDB answers reproduce it", () => {
  const r = random(0xa11);
  const doubles = [
    ...Array.from({ length: 2_000 }, () => (r.next() - 0.5) * 10 ** Math.floor(r.next() * 24 - 8)),
    ...Array.from({ length: 500 }, () => Math.round((r.next() - 0.5) * 2e4) / 100 + 0.05),
    0.05,
    -0.05,
    0.15,
    2.25,
    -2.25,
    1e15 + 0.5,
    123456789012.35,
    1e-300,
    1e300,
  ];

  it('rounds a double to tenths as `round(x::numeric, 1)::float8` does', async () => {
    const res = await pg.db.query<{ v: number }>(
      'SELECT round(x::numeric, 1)::float8 AS v FROM unnest($1::float8[]) WITH ORDINALITY t(x, i) ORDER BY i',
      [doubles],
    );
    expect(doubles.map(roundTenths)).toEqual(res.rows.map((row) => row.v));
  });

  it('divides real sums as a `real` division does', async () => {
    const pairs = Array.from({ length: 2_000 }, () => [
      Math.fround(Math.floor(r.next() * 1e4) * r.pick([1, 0.5, 0.25])),
      Math.fround(1 + Math.floor(r.next() * 1e5) * r.pick([1, 0.5])),
    ]);
    const res = await pg.db.query<{ v: number }>(
      `SELECT (a::real / nullif(b::real, 0))::float8 AS v
         FROM unnest($1::float8[], $2::float8[]) WITH ORDINALITY t(a, b, i) ORDER BY i`,
      [pairs.map((p) => p[0]), pairs.map((p) => p[1])],
    );
    expect(pairs.map(([a, b]) => realRatio(a ?? 0, b ?? 0))).toEqual(res.rows.map((row) => row.v));
  });

  it("prints JSON values as `jsonb`'s `->>` does", async () => {
    const values: unknown[] = [...doubles, 0, -0, 1e21, 1e-7, 2 ** 53, 'text', '$x', true, false, null, 7, -12];
    const res = await pg.db.query<{ v: string | null }>(
      "SELECT j->>'v' AS v FROM unnest($1::jsonb[]) WITH ORDINALITY t(j, i) ORDER BY i",
      [values.map((v) => JSON.stringify({ v }))],
    );
    const got = await mongo.mongo.db
      .aggregate<{ v: string | null }>([
        // Read back from JSON as ingest reads it (`-0` arrives as 0), and literal: `$x` is no field here.
        { $documents: { $literal: values.map((v) => JSON.parse(JSON.stringify({ v }))) } },
        { $project: { _id: 0, v: jsonText('$v') } },
      ])
      .toArray();
    expect(got.map((row) => row.v)).toEqual(res.rows.map((row) => row.v));
  });
});

describe('charts on MongoDB answer as on PostgreSQL', () => {
  it('series, by every dimension, interval, time zone and stat', async () => {
    const specs: Row[] = [];
    for (const [metric, { dims, filter, latency }] of Object.entries(METRICS)) {
      const stats = latency ? ['count', 'p95', 'avg'] : ['count', 'sum'];
      for (const groupBy of [undefined, ...dims]) {
        specs.push({
          kind: 'series',
          metric,
          range: RANGES.quarter,
          interval: 'day',
          groupBy,
          limit: 20,
          timezone: 'America/New_York',
        });
        specs.push({
          kind: 'series',
          metric,
          range: RANGES.week,
          interval: 'hour',
          groupBy,
          limit: 20,
          timezone: 'Asia/Kolkata',
        });
      }
      for (const stat of stats) {
        specs.push({
          kind: 'series',
          metric,
          range: RANGES.twoDays,
          interval: 'minute',
          stat,
          timezone: 'Australia/Lord_Howe',
        });
        specs.push({ kind: 'series', metric, range: RANGES.long, interval: 'week', stat });
        if (filter)
          specs.push({
            kind: 'series',
            metric,
            range: RANGES.month,
            interval: 'day',
            stat,
            filters: [filter],
            groupBy: dims[0],
            limit: 20,
          });
      }
    }
    for (const timezone of ZONES) {
      for (const interval of ['day', 'week', 'month']) {
        specs.push({
          kind: 'series',
          metric: 'interactions',
          range: RANGES.quarter,
          interval,
          timezone,
          groupBy: 'outcome',
        });
        specs.push({ kind: 'series', metric: 'interactions', range: RANGES.long, interval, timezone, stat: 'p50' });
      }
      specs.push({
        kind: 'series',
        metric: 'interactions',
        range: RANGES.londonAndNewYork,
        interval: 'hour',
        timezone,
        stat: 'p99',
      });
      specs.push({
        kind: 'series',
        metric: 'custom',
        name: 'ticket_opened',
        range: RANGES.lordHowe,
        interval: 'hour',
        timezone,
      });
      specs.push({
        kind: 'series',
        metric: 'interactions',
        range: RANGES.partHours,
        interval: 'hour',
        timezone,
        groupBy: 'command',
        limit: 20,
      });
      specs.push({
        kind: 'series',
        metric: 'interactions',
        range: RANGES.lastHour,
        interval: 'minute',
        timezone,
        groupBy: 'locale',
        limit: 20,
      });
    }
    specs.push(
      { kind: 'series', metric: 'interactions', range: RANGES.empty, interval: 'day' },
      {
        kind: 'series',
        metric: 'custom',
        name: 'purchase',
        range: RANGES.pastMonth,
        interval: 'day',
        timezone: 'Europe/London',
      },
      { kind: 'series', metric: 'custom', name: 'never_sent', range: RANGES.month, interval: 'day' },
      {
        kind: 'series',
        metric: 'interactions',
        range: RANGES.month,
        interval: 'day',
        groupBy: 'guild',
        filters: [{ field: 'guild', op: 'in', value: GUILDS.slice(0, 2) }],
        limit: 20,
      },
      {
        kind: 'series',
        metric: 'interactions',
        range: RANGES.month,
        interval: 'week',
        groupBy: 'tier',
        filters: [{ field: 'kind', value: 'message_command' }],
        limit: 20,
      },
      { kind: 'series', metric: 'interactions', range: RANGES.month, interval: 'day', groupBy: 'command', limit: 3 },
    );
    await compare(specs, 0.9);
  });

  it('top, by every dimension and stat', async () => {
    const specs: Row[] = [];
    for (const [metric, { dims, filter, latency }] of Object.entries(METRICS)) {
      for (const groupBy of dims) {
        for (const stat of latency ? ['count', 'avg', 'p50', 'p95', 'p99', 'sum'] : ['count', 'sum', 'avg']) {
          specs.push({ kind: 'top', metric, range: RANGES.quarter, groupBy, stat, limit: 500 });
        }
        specs.push({ kind: 'top', metric, range: RANGES.long, groupBy, limit: 500 });
        specs.push({ kind: 'top', metric, range: RANGES.partHours, groupBy, limit: 500 });
        if (filter) specs.push({ kind: 'top', metric, range: RANGES.month, groupBy, filters: [filter], limit: 500 });
      }
    }
    specs.push(
      { kind: 'top', metric: 'interactions', range: RANGES.empty, groupBy: 'command' },
      { kind: 'top', metric: 'interactions', range: RANGES.quarter, groupBy: 'command', limit: 2 },
      {
        kind: 'top',
        metric: 'interactions',
        range: RANGES.pastMonth,
        groupBy: 'guild',
        filters: [{ field: 'outcome', op: 'in', value: ['error', 'timeout'] }],
      },
    );
    await compare(specs, 0.9);
  });

  it('heatmap, in every time zone', async () => {
    const specs: Row[] = [];
    for (const timezone of ZONES) {
      for (const range of [RANGES.quarter, RANGES.long, RANGES.londonAndNewYork, RANGES.lordHowe, RANGES.partHours]) {
        specs.push({ kind: 'heatmap', range, timezone });
      }
      specs.push({
        kind: 'heatmap',
        metric: 'components',
        range: RANGES.month,
        timezone,
        filters: [{ field: 'outcome', value: 'error' }],
      });
      specs.push({ kind: 'heatmap', metric: 'rest.calls', range: RANGES.quarter, timezone });
    }
    specs.push({ kind: 'heatmap', range: RANGES.empty });
    await compare(specs, 0.9);
  });
});

describe('commands on MongoDB answer as on PostgreSQL', () => {
  it('commands, against the period before', async () => {
    await compare(
      Object.values(RANGES).map((range) => ({ kind: 'commands', range })),
      0.9,
    );
  });

  it('command, for each command and range', async () => {
    const names = [
      ...COMMANDS.map((c) => c.name),
      'warn',
      'legacy-stats',
      '🎲roll',
      'ｆｕｌｌ',
      '$weight',
      'never-ran',
    ];
    const ranges = [RANGES.lastDay, RANGES.month, RANGES.quarter, RANGES.long, RANGES.pastMonth, RANGES.empty];
    await compare(
      names.flatMap((name) => ranges.map((range) => ({ kind: 'command', name, range }))),
      0.6,
    );
  });
});

describe('the overview on MongoDB answers as on PostgreSQL', () => {
  it('overview', async () => {
    await compare([{ kind: 'overview' }], 1);
  });
});

describe('custom events, funnels and cohorts on MongoDB answer as on PostgreSQL', () => {
  const NAMES = ['ticket_opened', 'ticket_closed', 'signup', 'purchase', 'level_up', 'never_sent'];

  it('events and eventProps', async () => {
    const specs: Row[] = [];
    for (const range of [RANGES.lastDay, RANGES.month, RANGES.quarter, RANGES.long, RANGES.empty]) {
      specs.push({ kind: 'events', range });
      for (const name of NAMES) {
        specs.push({ kind: 'eventProps', name, range });
        for (const prop of ['category', 'priority', 'vip', 'note', 'amount', 'a.b', '$x', 'resolved', 'missing']) {
          specs.push({ kind: 'eventProps', name, range, prop });
        }
      }
    }
    await compare(specs, 0.5);
  });

  it('funnel, by window and time zone', async () => {
    const event = (name: string) => ({ type: 'event', name });
    const command = (name: string) => ({ type: 'command', name });
    const journeys = [
      [event('ticket_opened'), event('ticket_closed')],
      [command('ticket'), event('ticket_opened'), event('ticket_closed')],
      [command('ping'), command('ping')],
      [event('signup'), command('ticket'), event('ticket_opened'), command('config'), event('purchase')],
      [command('ban'), event('never_sent')],
    ];
    const specs: Row[] = [];
    for (const steps of journeys) {
      for (const windowHours of [1, 24, 168]) {
        for (const timezone of ['UTC', 'Australia/Lord_Howe', 'America/New_York']) {
          specs.push({ kind: 'funnel', steps, range: RANGES.quarter, windowHours, timezone });
        }
        specs.push({ kind: 'funnel', steps, range: RANGES.month, windowHours, timezone: 'Asia/Kolkata' });
      }
      specs.push({ kind: 'funnel', steps, range: RANGES.empty });
    }
    await compare(specs, 0.85);
  });

  it('retention, by interval and time zone', async () => {
    const starts = [
      { type: 'event', name: 'ticket_opened' },
      { type: 'command', name: 'ticket' },
    ];
    const returns = ['any', { type: 'event', name: 'ticket_closed' }, { type: 'command', name: 'ping' }];
    const specs: Row[] = [];
    for (const start of starts) {
      for (const back of returns) {
        for (const interval of ['day', 'week']) {
          for (const timezone of ZONES) {
            specs.push({ kind: 'retention', start, return: back, range: RANGES.quarter, interval, timezone });
          }
          specs.push({
            kind: 'retention',
            start,
            return: back,
            range: RANGES.lordHowe,
            interval,
            timezone: 'Australia/Lord_Howe',
          });
        }
      }
    }
    specs.push({ kind: 'retention', start: starts[0], range: RANGES.empty });
    await compare(specs, 0.9);
  });
});
