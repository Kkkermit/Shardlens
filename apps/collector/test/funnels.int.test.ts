import { readFileSync } from 'node:fs';
import { uuidv7 } from '@shardlens/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  APP_ID,
  envelope,
  type Harness,
  ingest,
  interaction,
  onPostgres,
  query,
  sdkHasher,
  startHarness,
} from './harness.js';

const HOUR = 3_600_000;
const GUILD_A = '112233445566778899';
const GUILD_B = '223344556677889900';
const [ALICE, BOB, CAROL, DAVE] = [
  '300000000000000001',
  '300000000000000002',
  '300000000000000003',
  '300000000000000004',
];

let h: Harness;
let hash: (userId: string) => Promise<string>;
const t0 = Date.now() - 20 * HOUR;
// Starts 3 hours before t0, so hourly rollup buckets for the earliest command fall inside it.
const range = { from: new Date(t0 - 3 * HOUR).toISOString(), to: new Date(Date.now() + 60_000).toISOString() };

const custom = async (user: string, name: string, ts: number, props: Record<string, unknown> = {}) => ({
  id: uuidv7(ts),
  ts,
  type: 'custom',
  name,
  props,
  user: await hash(user),
  guild: GUILD_A,
});

beforeAll(async () => {
  h = await startHarness();
  const { hasher, period } = await sdkHasher(h.app);
  hash = async (userId) => (await hasher.hash(userId, period)) as string;

  const events = [
    // Alice: opens, then closes 1 hour later (converts).
    await custom(ALICE, 'ticket_opened', t0, { category: 'billing' }),
    await custom(ALICE, 'ticket_closed', t0 + HOUR, { resolved: true }),
    // Bob: opens, never closes.
    await custom(BOB, 'ticket_opened', t0 + 2 * HOUR, { category: 'support' }),
    // Carol: closes before she opens, so she doesn't convert.
    await custom(CAROL, 'ticket_closed', t0 + 3 * HOUR),
    await custom(CAROL, 'ticket_opened', t0 + 4 * HOUR, { category: 'billing' }),
    // Dave: opens, closes 30 hours later (outside a 24-hour window).
    await custom(DAVE, 'ticket_opened', t0 - 10 * HOUR + 60_000),
    await custom(DAVE, 'ticket_closed', t0 + 20 * HOUR - 60_000),
    // Commands: Alice and Bob ran /ticket in server A, Carol in server B.
    interaction(await hash(ALICE), { id: uuidv7(t0 - HOUR / 2), ts: t0 - HOUR / 2 }),
    interaction(await hash(BOB), { id: uuidv7(t0 + HOUR), ts: t0 + HOUR }),
    interaction(await hash(CAROL), { id: uuidv7(t0 + HOUR), ts: t0 + HOUR, guild: GUILD_B, locale: 'de' }),
  ];
  const res = await ingest(h.app, envelope(events));
  expect(res.statusCode).toBe(202);
  expect(res.json()).toMatchObject({ rejected: [] });
  await h.store.jobs.runRollups(new Date());
}, 120_000);

afterAll(async () => {
  await h?.close();
});

describe('custom events', () => {
  it('lists events with counts and distinct people', async () => {
    const res = await query(h.app, { kind: 'events', range });
    expect(res.statusCode).toBe(200);
    const rows = res.json().rows as { name: string; count: number; users: number }[];
    // Dave opened before the range; his close is inside it.
    expect(rows.find((r) => r.name === 'ticket_opened')).toMatchObject({ count: 3, users: 3 });
    expect(rows.find((r) => r.name === 'ticket_closed')).toMatchObject({ count: 3, users: 3 });
    expect(JSON.stringify(res.json())).not.toMatch(/h1:|\\\\x/);
  });

  it('breaks an event down by property key and value', async () => {
    const keys = await query(h.app, { kind: 'eventProps', name: 'ticket_opened', range });
    expect(keys.json().keys).toEqual([{ key: 'category', count: 3 }]);
    const values = await query(h.app, { kind: 'eventProps', name: 'ticket_opened', prop: 'category', range });
    expect(values.json().values).toEqual([
      { value: 'billing', count: 2 },
      { value: 'support', count: 1 },
    ]);
  });
});

describe('funnels', () => {
  it('counts people who did each step in order within the window', async () => {
    const res = await query(h.app, {
      kind: 'funnel',
      range,
      windowHours: 24,
      steps: [
        { type: 'event', name: 'ticket_opened' },
        { type: 'event', name: 'ticket_closed' },
      ],
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Dave entered before the range starts, so he isn't in it. Alice converts; Bob and Carol don't.
    expect(body.steps.map((s: { users: number }) => s.users)).toEqual([3, 1]);
    expect(body.steps[1].medianSeconds).toBeCloseTo(3600, 0);
    expect(body.cohorts.reduce((n: number, c: { users: number[] }) => n + (c.users[0] ?? 0), 0)).toBe(3);
  });

  it('mixes commands and events, and respects the window', async () => {
    const res = await query(h.app, {
      kind: 'funnel',
      range: { from: new Date(t0 - 12 * HOUR).toISOString(), to: range.to },
      windowHours: 2,
      steps: [
        { type: 'command', name: 'ticket' },
        { type: 'event', name: 'ticket_opened' },
        { type: 'event', name: 'ticket_closed' },
      ],
    });
    // /ticket: Alice, Bob, Carol. Then opened within 2 h: Alice (+30 min), Bob (+1 h); Carol opened 3 h later.
    // Then closed within 2 h of /ticket: Alice (+1.5 h).
    expect(res.json().steps.map((s: { users: number }) => s.users)).toEqual([3, 2, 1]);
  });

  it('rejects funnels with too few or too many steps', async () => {
    const one = await query(h.app, { kind: 'funnel', range, steps: [{ type: 'event', name: 'ticket_opened' }] });
    expect(one.statusCode).toBe(400);
    const six = Array.from({ length: 6 }, () => ({ type: 'event', name: 'ticket_opened' }));
    expect((await query(h.app, { kind: 'funnel', range, steps: six })).statusCode).toBe(400);
  });
});

describe('cohort builder', () => {
  it('groups people by when they started and counts who came back later', async () => {
    const res = await query(h.app, {
      kind: 'retention',
      range: { from: new Date(t0 - 12 * HOUR).toISOString(), to: range.to },
      start: { type: 'event', name: 'ticket_opened' },
      return: 'any',
      interval: 'day',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { cohorts: { cohort: string; size: number; retained: number[] }[]; periods: number };
    expect(body.periods).toBe(14);
    expect(body.cohorts.reduce((n, c) => n + c.size, 0)).toBe(4);
    for (const c of body.cohorts) expect(c.retained).toHaveLength(14);
  });
});

describe('interactions.by_guild', () => {
  it('keeps the server out of the interactions rollup and in its own metric', async () => {
    const rows = onPostgres
      ? (
          await h.db.query<{ metric: string; dims: Record<string, unknown> }>(
            "SELECT metric, dims FROM rollup_1h WHERE app_id = $1 AND metric LIKE 'interactions%'",
            [APP_ID],
          )
        ).rows
      : await h.mongo.c.rollup1h.find({ appId: APP_ID, metric: /^interactions/ }).toArray();
    const plain = rows.filter((r) => r.metric === 'interactions');
    const byGuild = rows.filter((r) => r.metric === 'interactions.by_guild');
    expect(plain.length).toBeGreaterThan(0);
    expect(plain.every((r) => !('guild' in r.dims))).toBe(true);
    expect(new Set(byGuild.map((r) => r.dims.guild))).toEqual(new Set([GUILD_A, GUILD_B]));
  });

  it('answers per-server questions from the split metric', async () => {
    const top = await query(h.app, { kind: 'top', metric: 'interactions', range, groupBy: 'guild' });
    expect(top.statusCode).toBe(200);
    const counts = Object.fromEntries(
      (top.json().rows as { key: string; count: number }[]).map((r) => [r.key, r.count]),
    );
    expect(counts).toEqual({ [GUILD_A]: 2, [GUILD_B]: 1 });

    const filtered = await query(h.app, {
      kind: 'top',
      metric: 'interactions',
      range,
      groupBy: 'command',
      filters: [{ field: 'guild', value: GUILD_B }],
    });
    expect(filtered.json().rows).toEqual([expect.objectContaining({ key: 'ticket', count: 1 })]);

    const commands = await query(h.app, { kind: 'commands', range });
    expect(commands.json().rows.find((r: { command: string }) => r.command === 'ticket')).toMatchObject({
      runs: 3,
      servers: 2,
    });
  });

  it('refuses per-server splits by dimensions the split metric does not keep', async () => {
    const res = await query(h.app, {
      kind: 'top',
      metric: 'interactions',
      range,
      groupBy: 'locale',
      filters: [{ field: 'guild', value: GUILD_A }],
    });
    expect(res.statusCode).toBe(400);
  });

  it.runIf(onPostgres)('migration 003 converts old rollups that still carry the server', async () => {
    const bucket = new Date(Math.floor((Date.now() - 400 * 86_400_000) / 86_400_000) * 86_400_000);
    const old = (guild: string, count: number) => ({
      kind: 1,
      command: 'legacy',
      sub: null,
      outcome: 0,
      context: 0,
      install: 0,
      guild,
      locale: 'en-GB',
      tier: 1,
      count,
    });
    for (const row of [old(GUILD_A, 5), old(GUILD_B, 7)]) {
      const { count, ...dims } = row;
      await h.db.query(
        `INSERT INTO rollup_1d (app_id, bucket, metric, dims_hash, dims, count, sum)
         VALUES ($1, $2, 'interactions', sha256(convert_to($3::jsonb::text, 'UTF8')), $3::jsonb, $4, 0)`,
        [APP_ID, bucket, JSON.stringify(dims), count],
      );
    }
    const up = readFileSync(new URL('../migrations/003_interactions_by_guild.sql', import.meta.url), 'utf8');
    const client = await h.db.connect();
    try {
      await client.query('BEGIN');
      await client.query(up);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const after = await h.db.query<{ metric: string; dims: Record<string, unknown>; count: number }>(
      "SELECT metric, dims, count FROM rollup_1d WHERE app_id = $1 AND bucket = $2 AND dims->>'command' = 'legacy'",
      [APP_ID, bucket],
    );
    const plain = after.rows.filter((r) => r.metric === 'interactions');
    expect(plain).toHaveLength(1);
    expect(plain[0]?.count).toBe(12);
    expect(plain[0]?.dims).not.toHaveProperty('guild');
    const split = after.rows.filter((r) => r.metric === 'interactions.by_guild').map((r) => [r.dims.guild, r.count]);
    expect(Object.fromEntries(split)).toEqual({ [GUILD_A]: 5, [GUILD_B]: 7 });
  });
});
