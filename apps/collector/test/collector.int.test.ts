import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { bucketOf, uuidv7 } from '@shardlens/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { signInProblems } from '../src/app.js';
import { createPool, migrate } from '../src/db.js';
import { backfillRollups, runRollups, runUniques } from '../src/jobs/rollups.js';
import { runRetention, runSalts } from '../src/jobs/scheduler.js';
import { allowedUser } from '../src/routes/auth.js';
import { KeyStore, seedKey } from '../src/security/auth.js';
import { buildServer } from '../src/server.js';
import { periodIdent } from '../src/storage/periods.js';
import { PostgresStore } from '../src/storage/postgres/store.js';
import { activeSalts } from '../src/storage/salts.js';
import {
  APP_ID,
  envelope,
  guildInfo,
  type Harness,
  INGEST_KEY,
  ingest,
  interaction,
  query,
  READ_KEY,
  sdkHasher,
  snowflakeOnShard,
  startHarness,
} from './harness.js';

let h: Harness;
const GUILD = '112233445566778899';

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h?.close();
});

describe('schema and SQL helpers', () => {
  it('matches the TypeScript histogram bucket for every duration', async () => {
    const samples = [0, 0.5, 1, 1.5, 2, 5, 10, 50, 80, 120, 200, 999, 3_000, 9_999, 59_999, 60_000, 120_000];
    const res = await h.db.query<{ ms: number; b: number }>(
      'SELECT ms, shardlens_bucket(ms) AS b FROM unnest($1::float8[]) AS ms',
      [samples],
    );
    for (const row of res.rows) expect(row.b, `bucket for ${row.ms} ms`).toBe(bucketOf(row.ms));
    expect(res.rows.find((r) => r.ms === 120)?.b).toBe(16);
  });
});

describe('ingest', () => {
  it('rejects requests without a valid ingest key', async () => {
    const batch = envelope([interaction('h1:2026-11:00000000000000000000000000000000')]);
    expect((await ingest(h.app, batch, 'slk_ingest_wrong')).statusCode).toBe(401);
    expect((await ingest(h.app, batch, READ_KEY)).statusCode).toBe(401);
    const noAuth = await h.app.inject({ method: 'POST', url: '/v1/ingest', payload: batch });
    expect(noAuth.statusCode).toBe(401);
  });

  it('serves the current salt to ingest keys only', async () => {
    const ok = await h.app.inject({
      method: 'GET',
      url: '/v1/config',
      headers: { authorization: `Bearer ${INGEST_KEY}` },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ v: 1, appId: APP_ID, mode: 'privacy', saltPeriod: 'month' });
    const read = await h.app.inject({
      method: 'GET',
      url: '/v1/config',
      headers: { authorization: `Bearer ${READ_KEY}` },
    });
    expect(read.statusCode).toBe(401);
  });

  it('accepts a batch once and ignores the retried duplicate', async () => {
    const { hasher, period } = await sdkHasher(h.app);
    const events = await Promise.all(
      ['111111111111111111', '222222222222222222', '333333333333333333'].map(async (u, i) =>
        interaction((await hasher.hash(u, period))!, { ackMs: 100 + i * 50 }),
      ),
    );
    const batch = envelope(events);
    const first = await ingest(h.app, batch);
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({ accepted: 3, duplicates: 0, rejected: [] });
    const retry = await ingest(h.app, batch);
    expect(retry.json()).toMatchObject({ accepted: 0, duplicates: 3 });
  });

  it('counts a batch once in the live tiles, even when the SDK sends it again', async () => {
    const { hasher, period } = await sdkHasher(h.app);
    const user = (await hasher.hash('121212121212121212', period))!;
    const probe = { command: 'live_probe' };
    // PostgreSQL hands IDs back in lower case; an SDK may send them in upper case.
    const shouted = { ...probe, id: uuidv7().toUpperCase(), outcome: 'error' };
    const batch = envelope([interaction(user, probe), interaction(user, shouted)]);
    const before = h.live.tiles(APP_ID);
    try {
      expect((await ingest(h.app, batch)).json()).toMatchObject({ accepted: 2 });
      expect((await ingest(h.app, batch)).json()).toMatchObject({ duplicates: 2 });
      expect(h.live.tiles(APP_ID)).toMatchObject({ perMinute: before.perMinute + 2, errors15m: before.errors15m + 1 });
    } finally {
      await h.db.query("DELETE FROM interactions WHERE command = 'live_probe'");
    }
  });

  it('counts a retried server availability change as a duplicate', async () => {
    const event = {
      id: uuidv7(),
      ts: Date.now(),
      type: 'guild_availability',
      guild: GUILD,
      available: false,
      shard: 0,
    };
    expect((await ingest(h.app, envelope([event]))).json()).toMatchObject({ accepted: 1, duplicates: 0 });
    expect((await ingest(h.app, envelope([event]))).json()).toMatchObject({ accepted: 0, duplicates: 1 });
  });

  it('keeps the newest bot name when an older app report arrives late', async () => {
    const report = (name: string, ts: number) => ({
      id: uuidv7(ts),
      ts,
      type: 'app_info',
      name,
      approximateGuildCount: 3,
      approximateUserInstallCount: null,
      approximateUserAuthorizationCount: null,
      dashboardUserIds: [],
      eventWebhooksStatus: 1,
      skus: [],
      nodeVersion: 'v24.11.0',
      libVersion: '14.22.0',
    });
    try {
      await ingest(h.app, envelope([report('Newer name', Date.now())]));
      await ingest(h.app, envelope([report('Older name', Date.now() - 3_600_000)]));
      const meta = await h.app.inject({
        method: 'GET',
        url: '/v1/meta',
        headers: { authorization: `Bearer ${READ_KEY}` },
      });
      expect(meta.json().name).toBe('Newer name');
    } finally {
      await h.db.query('DELETE FROM app_info WHERE app_id = $1', [APP_ID]);
      await h.db.query("UPDATE apps SET name = '' WHERE app_id = $1", [APP_ID]);
    }
  });

  it('drops events carrying identifying data in privacy mode, and audit batches when the app is in privacy mode', async () => {
    const { hasher, period } = await sdkHasher(h.app);
    const user = (await hasher.hash('444444444444444444', period))!;
    const withActor = interaction(user, { actor: { userId: '444444444444444444' } });
    const res = await ingest(h.app, envelope([interaction(user), withActor]));
    expect(res.json()).toMatchObject({ accepted: 1, rejected: [{ index: 1, reason: 'actor_in_privacy_mode' }] });
    const stored = await h.db.query("SELECT count(*)::int AS n FROM interactions WHERE options @> '{category}'");
    expect(stored.rows[0].n).toBeGreaterThan(0);

    const audit = await ingest(h.app, envelope([interaction(user)], { mode: 'audit' }));
    expect(audit.statusCode).toBe(400);
    expect(audit.json().error).toBe('audit_mode_disabled');
  });

  it('refuses hashes from unknown or destroyed salt periods', async () => {
    const res = await ingest(h.app, envelope([interaction('h1:1999-01:00000000000000000000000000000000')]));
    expect(res.json()).toMatchObject({ accepted: 0, rejected: [{ index: 0, reason: 'unknown_salt_period' }] });
  });

  it('rejects gzip bombs and oversized bodies', async () => {
    const bomb = gzipSync(Buffer.alloc(6 * 1024 * 1024));
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/ingest',
      headers: {
        authorization: `Bearer ${INGEST_KEY}`,
        'content-type': 'application/json',
        'content-encoding': 'gzip',
      },
      payload: bomb,
    });
    expect(res.statusCode).toBe(413);
    const big = await h.app.inject({
      method: 'POST',
      url: '/v1/ingest',
      headers: { authorization: `Bearer ${INGEST_KEY}`, 'content-type': 'application/json' },
      payload: Buffer.alloc(2 * 1024 * 1024, 32),
    });
    expect(big.statusCode).toBe(413);
  });

  it('answers 400, not "too large", to a body that says it is gzip and is not', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/ingest',
      headers: {
        authorization: `Bearer ${INGEST_KEY}`,
        'content-type': 'application/json',
        'content-encoding': 'gzip',
      },
      payload: Buffer.from(JSON.stringify(envelope([]))),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_encoding' });
  });

  it('rejects prototype-poisoning payloads', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/ingest',
      headers: { authorization: `Bearer ${INGEST_KEY}`, 'content-type': 'application/json' },
      payload: '{"__proto__": {"polluted": true}, "v": 1}',
    });
    expect(res.statusCode).toBe(400);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('rejects events older than their table keeps, per event, instead of failing the batch', async () => {
    const old = Date.now() - 32 * 86_400_000;
    const res = await ingest(
      h.app,
      envelope([
        { id: uuidv7(old), ts: old, type: 'gauge_window', gauges: [{ name: 'memory.rss_bytes', value: 1 }] },
        { id: uuidv7(), ts: Date.now(), type: 'gauge_window', gauges: [{ name: 'memory.rss_bytes', value: 2 }] },
        {
          id: uuidv7(Date.now() - 40 * 86_400_000),
          ts: Date.now() - 40 * 86_400_000,
          type: 'custom',
          name: 'x',
          props: {},
        },
      ]),
    );
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({
      accepted: 1,
      rejected: [
        { index: 0, reason: 'too_old' },
        { index: 2, reason: 'too_old' },
      ],
    });
  });

  it('rolls up late events older than minute retention straight into hourly and daily rollups', async () => {
    // A raw row 20 days old (minute rollups only cover 14 days), marked dirty the way ingest marks late events.
    const ts = new Date(Date.now() - 20 * 86_400_000);
    await h.db.query(
      `INSERT INTO interactions (id, ts, app_id, env, kind, command, locale, user_hash, salt_period, premium, outcome, ack_ms)
       VALUES ($1, $2, $3, 'production', 1, 'late_one', 'en-GB', $4, '2026-01', false, 0, 100)`,
      [uuidv7(ts.getTime()), ts, APP_ID, Buffer.alloc(16)],
    );
    await h.db.query("INSERT INTO dirty_buckets (app_id, bucket) VALUES ($1, date_trunc('minute', $2::timestamptz))", [
      APP_ID,
      ts,
    ]);
    await runRollups(h.db, new Date());
    const n = async (table: string) =>
      (
        await h.db.query(
          `SELECT coalesce(sum(count), 0)::int AS n FROM ${table} WHERE metric = 'interactions' AND dims->>'command' = 'late_one'`,
        )
      ).rows[0].n;
    expect(await n('rollup_1h')).toBe(1);
    expect(await n('rollup_1d')).toBe(1);
    expect(await n('rollup_1m')).toBe(0);
    const left = await h.db.query('SELECT count(*)::int AS n FROM dirty_buckets');
    expect(left.rows[0].n).toBe(0);
  });

  it('warns at start-up when the bot or its owner would have no way in, and says why Discord sign-in is refused', async () => {
    expect(await signInProblems(h.store, h.config)).toEqual([]);
    const fresh = { ...h.config, appId: '1234567890123456780' };
    await h.db.query('INSERT INTO apps (app_id) VALUES ($1) ON CONFLICT DO NOTHING', [fresh.appId]);
    expect(await signInProblems(h.store, fresh)).toEqual([
      expect.stringMatching(/^No ingest key/),
      expect.stringMatching(/^No way to open the dashboard/),
    ]);
    const discordOnly = { ...fresh, discord: { clientId: fresh.appId, clientSecret: 'x'.repeat(32) } };
    expect(await signInProblems(h.store, discordOnly)).toEqual([
      expect.stringMatching(/^No ingest key/),
      expect.stringMatching(/^Discord sign-in works once the bot has reported/),
    ]);
    expect(await signInProblems(h.store, { ...discordOnly, extraAdmins: ['334455667788990011'] })).toHaveLength(1);
    // Without the dashboard there is no Settings page to create a key in: a collector nothing can read is said so.
    expect(await signInProblems(h.store, { ...discordOnly, dashboard: false })).toEqual([
      expect.stringMatching(/^No ingest key/),
      expect.stringMatching(/^No read key, and the dashboard is off/),
    ]);
    expect(await signInProblems(h.store, { ...h.config, dashboard: false })).toEqual([]);

    const deps = { config: discordOnly, store: h.store } as unknown as Parameters<typeof allowedUser>[0];
    expect(await allowedUser(deps, fresh.appId, '334455667788990011')).toBe('bot_not_reported');
    await h.db.query(
      `INSERT INTO app_info (app_id, ts, name, dashboard_user_ids) VALUES ($1, now(), 'bot', ARRAY[334455667788990011]::bigint[])`,
      [fresh.appId],
    );
    expect(await allowedUser(deps, fresh.appId, '334455667788990011')).toBe('ok');
    expect(await allowedUser(deps, fresh.appId, '445566778899001122')).toBe('not_a_team_member');
  });

  it('rejects a batch for another app', async () => {
    const res = await ingest(
      h.app,
      envelope([interaction('h1:2026-11:00000000000000000000000000000000')], {
        app: { id: '999999999999999999', env: 'production' },
      }),
    );
    expect(res.statusCode).toBe(403);
  });
});

describe('ingest edge cases', () => {
  // Two days back, outside the ranges the rollup tests below count.
  const earlier = () => Date.now() - 2 * 86_400_000;
  const cleanUp = () => h.db.query("DELETE FROM interactions WHERE command LIKE 'edge_%'");

  it('stores the rest of a batch when the database refuses one of its values', async () => {
    const { hasher, period } = await sdkHasher(h.app);
    const user = (await hasher.hash('700000000000000111', period))!;
    const res = await ingest(
      h.app,
      envelope([
        interaction(user, { command: 'edge_kept', ts: earlier() }),
        // Wider than its column (smallint).
        interaction(user, { command: 'edge_refused', ts: earlier(), channelType: 40_000 }),
      ]),
    );
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ accepted: 1, rejected: [{ index: 1, reason: 'refused_by_database' }] });
    const rows = await h.db.query("SELECT command FROM interactions WHERE command LIKE 'edge_%'");
    expect(rows.rows).toEqual([{ command: 'edge_kept' }]);
    await cleanUp();
  });

  it('keeps an option value cut through an emoji, with the broken half replaced', async () => {
    const { hasher, period } = await sdkHasher(h.app);
    const user = (await hasher.hash('700000000000000112', period))!;
    const res = await ingest(
      h.app,
      envelope([
        interaction(user, { command: 'edge_emoji', ts: earlier(), optionValues: { category: 'pizza \ud83c' } }),
      ]),
    );
    expect(res.json(), res.body).toMatchObject({ accepted: 1, rejected: [] });
    const row = await h.db.query(
      "SELECT option_values->>'category' AS v FROM interactions WHERE command = 'edge_emoji'",
    );
    expect(row.rows[0].v).toBe('pizza \ufffd');
    await cleanUp();
  });

  it('stores a retried batch once when the bot clock is minutes off', async () => {
    const { hasher, period } = await sdkHasher(h.app);
    const user = (await hasher.hash('700000000000000113', period))!;
    const event = interaction(user, { command: 'edge_skewed', ts: earlier() });
    const sentAt = Date.now() - 10 * 60_000;
    const send = (jitter: number) =>
      ingest(
        h.app,
        envelope([event], {
          sentAt: new Date(sentAt + jitter).toISOString(),
          source: { shards: [0], instance: 'skewed:1' },
        }),
      );
    expect((await send(0)).json()).toMatchObject({ accepted: 1 });
    // The retry is sent a little later: network delay makes the measured skew differ by milliseconds.
    expect((await send(7)).json()).toMatchObject({ accepted: 0, duplicates: 1 });
    const rows = await h.db.query("SELECT count(*)::int AS n FROM interactions WHERE command = 'edge_skewed'");
    expect(rows.rows[0].n).toBe(1);
    await cleanUp();
  });

  it('accepts a command list naming one command twice', async () => {
    const command = { id: '1300000000000000001', name: 'edge', type: 1, subcommands: [] };
    const res = await ingest(
      h.app,
      envelope([
        { id: uuidv7(), ts: Date.now(), type: 'command_registry', commands: [command, { ...command, name: 'edge2' }] },
      ]),
    );
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ accepted: 1, rejected: [] });
    await h.db.query('DELETE FROM command_registry WHERE command_id = $1', [command.id]);
  });

  it('keeps two entitlements bought in the same millisecond, and counts a retried event as a duplicate', async () => {
    const { hasher, period } = await sdkHasher(h.app);
    const ts = earlier();
    const entitlement = async (userId: string) => ({
      id: uuidv7(ts),
      ts,
      type: 'entitlement',
      action: 'create',
      sku: '1300000000000000002',
      entitlementType: 8,
      owner: 'user',
      user: (await hasher.hash(userId, period))!,
      startsAt: null,
      endsAt: null,
    });
    const batch = envelope([await entitlement('700000000000000114'), await entitlement('700000000000000115')]);
    expect((await ingest(h.app, batch)).json()).toMatchObject({ accepted: 2, duplicates: 0 });
    expect((await ingest(h.app, batch)).json()).toMatchObject({ accepted: 0, duplicates: 2 });
    const rows = await h.db.query('SELECT count(*)::int AS n FROM entitlements WHERE sku_id = 1300000000000000002');
    expect(rows.rows[0].n).toBe(2);
  });

  it('marks the minute of a late server outage for the rollups to recount', async () => {
    const ts = Date.now() - 20 * 60_000;
    const res = await ingest(
      h.app,
      envelope([
        { id: uuidv7(ts), ts, type: 'guild_availability', guild: '1300000000000000003', available: false, shard: 0 },
      ]),
    );
    expect(res.json()).toMatchObject({ accepted: 1 });
    const minute = new Date(Math.floor(ts / 60_000) * 60_000);
    const dirty = await h.db.query('SELECT count(*)::int AS n FROM dirty_buckets WHERE bucket = $1', [minute]);
    expect(dirty.rows[0].n).toBe(1);
  });
});

describe('rollups, uniques and queries', () => {
  beforeAll(async () => {
    const { hasher, period } = await sdkHasher(h.app);
    const events = [];
    for (let i = 0; i < 100; i++) {
      const user = (await hasher.hash(String(500000000000000000n + BigInt(i % 10)), period))!;
      events.push(
        interaction(user, {
          command: i % 4 === 0 ? 'help' : 'ticket',
          channelType: i % 4 === 0 ? 11 : 0,
          outcome: i % 20 === 0 ? 'error' : 'ok',
          ackMs: 50 + i * 10,
          ts: Date.now() - (i % 3) * 60_000,
        }),
      );
    }
    await h.db.query('DELETE FROM interactions');
    await h.db.query('DELETE FROM uniques');
    await h.db.query('DELETE FROM unique_counts');
    const res = await ingest(h.app, envelope(events));
    expect(res.json().accepted).toBe(100);
    await runRollups(h.db, new Date());
    await runUniques(h.db);
  });

  const range = () => ({
    from: new Date(Date.now() - 86_400_000).toISOString(),
    to: new Date(Date.now() + 3_600_000).toISOString(),
  });

  it('shows hourly buckets at their real start in a time zone half an hour off UTC', async () => {
    const res = await query(h.app, {
      kind: 'series',
      metric: 'interactions',
      range: range(),
      interval: 'hour',
      timezone: 'Asia/Kolkata',
    });
    expect(res.statusCode, res.body).toBe(200);
    const points = res.json().points as { t: string }[];
    expect(points.length).toBeGreaterThan(0);
    // UTC hours start at half past in India (UTC+5:30), so the bucket holding 11:14 is 10:30–11:30, not 10:00.
    for (const point of points) expect(point.t).toMatch(/:30:00$/);
  });

  it('labels days older than 13 months with their UTC date, the only days kept that long', async () => {
    const day = new Date(Date.now() - 400 * 86_400_000).toISOString().slice(0, 10);
    const dims = { kind: 1, command: 'old_day', sub: null, outcome: 0 };
    await h.db.query(
      `INSERT INTO rollup_1d (app_id, bucket, metric, dims_hash, dims, count, sum)
       VALUES ($1, $2, 'interactions', sha256(convert_to($3::jsonb::text, 'UTF8')), $3::jsonb, 7, 0)`,
      [APP_ID, `${day}T00:00:00Z`, JSON.stringify(dims)],
    );
    const from = new Date(Date.parse(`${day}T00:00:00Z`) - 2 * 86_400_000).toISOString();
    const to = new Date(Date.parse(`${day}T00:00:00Z`) + 2 * 86_400_000).toISOString();
    const res = await query(h.app, {
      kind: 'series',
      metric: 'interactions',
      range: { from, to },
      interval: 'day',
      timezone: 'America/Los_Angeles',
      filters: [{ field: 'command', value: 'old_day' }],
    });
    expect(res.json().points).toEqual([expect.objectContaining({ t: `${day}T00:00:00`, value: 7 })]);
    await h.db.query("DELETE FROM rollup_1d WHERE dims->>'command' = 'old_day'");
  });

  it('counts every interaction exactly once in rollups', async () => {
    const res = await query(h.app, { kind: 'series', metric: 'interactions', range: range(), interval: 'day' });
    expect(res.statusCode).toBe(200);
    const total = (res.json().points as { value: number }[]).reduce((a, p) => a + p.value, 0);
    expect(total).toBe(100);
    // Re-running the job must not double count.
    await runRollups(h.db, new Date());
    const again = await query(h.app, { kind: 'series', metric: 'interactions', range: range(), interval: 'hour' });
    expect((again.json().points as { value: number }[]).reduce((a, p) => a + p.value, 0)).toBe(100);
  });

  it('ranks commands with error rates, latency and unique users', async () => {
    const res = await query(h.app, { kind: 'commands', range: range() });
    expect(res.statusCode).toBe(200);
    const rows = res.json().rows as { command: string; runs: number; errorRate: number; p95Ms: number }[];
    expect(rows.map((r) => [r.command, r.runs])).toEqual([
      ['ticket', 75],
      ['help', 25],
    ]);
    expect(rows[1]?.errorRate).toBeCloseTo(5 / 25);
    expect(rows[0]?.p95Ms).toBeGreaterThan(500);
  });

  it('breaks a command down by the type of channel it ran in', async () => {
    const detail = async (name: string) => (await query(h.app, { kind: 'command', name, range: range() })).json();
    expect((await detail('help')).channelTypes).toEqual([{ key: '11', value: 25 }]);
    expect((await detail('ticket')).channelTypes).toEqual([{ key: '0', value: 75 }]);
  });

  it('groups series by a dimension and decodes stored codes back to names', async () => {
    const res = await query(h.app, {
      kind: 'top',
      metric: 'interactions',
      range: range(),
      groupBy: 'outcome',
    });
    expect(res.json().rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'ok', count: 95 }),
        expect.objectContaining({ key: 'error', count: 5 }),
      ]),
    );
    const filtered = await query(h.app, {
      kind: 'top',
      metric: 'interactions',
      range: range(),
      groupBy: 'command',
      filters: [{ field: 'outcome', value: 'error' }],
    });
    expect(filtered.json().rows.reduce((a: number, r: { count: number }) => a + r.count, 0)).toBe(5);
  });

  it('counts unique users per day from salted hashes only', async () => {
    const res = await h.db.query<{ users: number }>(
      "SELECT sum(users)::int AS users FROM unique_counts WHERE grain = 'month' AND scope = 'global'",
    );
    expect(res.rows[0]?.users).toBe(10);
  });

  it('never lets a query group by user', async () => {
    const res = await query(h.app, { kind: 'top', metric: 'interactions', range: range(), groupBy: 'user' });
    expect(res.statusCode).toBe(400);
  });

  it('answers every dashboard query kind without SQL errors', async () => {
    const r = range();
    const specs = [
      { kind: 'overview' },
      { kind: 'command', name: 'ticket', range: r },
      { kind: 'servers' },
      { kind: 'servers', search: "o'brien %_\\", status: 'all', size: '11-100', inactive: true, sort: 'runs' },
      { kind: 'server', guild: GUILD },
      { kind: 'growth', range: r, timezone: 'Europe/London' },
      { kind: 'audience', range: r },
      { kind: 'heatmap', range: r, timezone: 'America/New_York' },
      { kind: 'series', metric: 'interactions', range: r, interval: 'hour', groupBy: 'command', stat: 'p95' },
      { kind: 'series', metric: 'rest.calls', range: r, interval: 'minute', stat: 'p99' },
      { kind: 'gauge', name: 'shard.ping_ms', range: r, interval: 'hour', perShard: true },
      { kind: 'bursts', range: r },
    ];
    for (const spec of specs) {
      const res = await query(h.app, spec);
      expect(res.statusCode, `${spec.kind}: ${res.body}`).toBe(200);
    }
  });

  it('requires a read key or session to query', async () => {
    const res = await h.app.inject({ method: 'POST', url: '/v1/query', payload: { kind: 'overview' } });
    expect(res.statusCode).toBe(401);
    const ingestKey = await h.app.inject({
      method: 'POST',
      url: '/v1/query',
      headers: { authorization: `Bearer ${INGEST_KEY}` },
      payload: { kind: 'overview' },
    });
    expect(ingestKey.statusCode).toBe(401);
  });

  it('reads a range that starts part-way through an hour from the start of that hour', async () => {
    // Every test interaction is under three minutes old, and hourly rollups are stored under the top of the hour.
    const lastTenMinutes = {
      from: new Date(Date.now() - 600_000).toISOString(),
      to: new Date(Date.now() + 60_000).toISOString(),
    };
    const top = await query(h.app, {
      kind: 'top',
      metric: 'interactions',
      range: lastTenMinutes,
      groupBy: 'command',
    });
    expect(top.json().rows.reduce((a: number, r: { count: number }) => a + r.count, 0)).toBe(100);
    const commands = await query(h.app, { kind: 'commands', range: lastTenMinutes });
    expect(commands.json().rows.reduce((a: number, r: { runs: number }) => a + r.runs, 0)).toBe(100);
    const heatmap = await query(h.app, { kind: 'heatmap', range: lastTenMinutes });
    expect(heatmap.json().cells.reduce((a: number, c: { value: number }) => a + c.value, 0)).toBe(100);
  });

  it('includes today in daily unique users when the range ends now', async () => {
    const res = await query(h.app, {
      kind: 'audience',
      range: { from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date().toISOString() },
    });
    const days = res.json().daily as { day: string; users: number }[];
    expect(days.at(-1)?.day).toBe(new Date().toISOString().slice(0, 10));
    expect(days.reduce((a, d) => a + d.users, 0)).toBeGreaterThanOrEqual(10);
  });

  it('refuses a dimension the metric does not keep, instead of answering with an empty key', async () => {
    const top = (spec: object) => query(h.app, { kind: 'top', range: range(), ...spec });
    const byRoute = await top({ metric: 'interactions', groupBy: 'route' });
    expect(byRoute.statusCode).toBe(400);
    expect(byRoute.json()).toMatchObject({
      error: 'invalid_query',
      message: expect.stringContaining("interactions can't be grouped or filtered by route: use kind, command"),
    });
    const custom = await top({ metric: 'custom', name: 'signup', groupBy: 'command' });
    expect(custom.json().message).toContain('custom events');
    const perServer = await top({
      metric: 'interactions',
      groupBy: 'guild',
      filters: [{ field: 'locale', value: 'en-GB' }],
    });
    expect(perServer.json().message).toContain('per-server interactions');
    const filtered = await query(h.app, {
      kind: 'series',
      metric: 'rest.calls',
      range: range(),
      interval: 'hour',
      filters: [{ field: 'command', value: 'ticket' }],
    });
    expect(filtered.statusCode).toBe(400);
  });

  it('counts a command that never answered as a missed deadline, and lists no empty subcommand', async () => {
    const { hasher, period } = await sdkHasher(h.app);
    const user = (await hasher.hash('600000000000000001', period))!;
    const unanswered = (outcome: string) =>
      interaction(user, { command: 'ping', sub: undefined, outcome, ackMs: undefined });
    const res = await ingest(
      h.app,
      envelope([
        unanswered('timeout'),
        unanswered('timeout'),
        unanswered('no_response'),
        unanswered('no_response'),
        unanswered('no_response'),
      ]),
    );
    expect(res.json().accepted).toBe(5);

    const reliability = (await query(h.app, { kind: 'reliability', range: range() })).json();
    expect(reliability.totals).toMatchObject({ runs: 105, missedDeadlines: 5, noResponse: 3 });
    expect(await h.store.alerts.metricValue(APP_ID, 'missed_deadline_rate', 3_600)).toBeCloseTo((100 * 5) / 105);
    const detail = (await query(h.app, { kind: 'command', name: 'ping', range: range() })).json();
    // None succeeded, failed or deferred: that is 0, not unknown.
    expect(detail.totals).toMatchObject({ runs: 5, ok: 0, error: 0, timeout: 2, noResponse: 3, deferRate: 0 });
    const never = (await query(h.app, { kind: 'command', name: 'never-ran', range: range() })).json();
    expect(never.totals).toMatchObject({ runs: null, ok: null, error: null, deferRate: null });
    expect(detail.subcommands).toEqual([]);
  });

  it('adds memory up across the processes of a sharded bot, and shows the worst event-loop delay', async () => {
    await h.db.query('DELETE FROM gauges');
    const ts = Date.now() - 30_000;
    const sample = (rssBytes: number, delayMs: number, shard: number) => ({
      id: uuidv7(),
      ts,
      type: 'gauge_window',
      gauges: [
        { name: 'memory.rss_bytes', value: rssBytes },
        { name: 'eventloop.p99_ms', value: delayMs },
        { name: 'shard.ping_ms', shard, value: delayMs * 10 },
      ],
    });
    await ingest(h.app, envelope([sample(100e6, 4, 0)], { source: { shards: [0], instance: 'host:1' } }));
    await ingest(h.app, envelope([sample(200e6, 9, 1)], { source: { shards: [1], instance: 'host:2' } }));

    const { process } = (await query(h.app, { kind: 'reliability', range: range() })).json();
    expect(process).toMatchObject({ 'memory.rss_bytes': 300e6, 'eventloop.p99_ms': 9 });

    const points = async (name: string) =>
      (await query(h.app, { kind: 'gauge', name, range: range(), interval: 'day' })).json().points;
    expect(await points('memory.rss_bytes')).toEqual([expect.objectContaining({ value: 300e6, max: 300e6 })]);
    // A latency is not a total: averaged across shards, with the worst as the maximum.
    expect(await points('shard.ping_ms')).toEqual([expect.objectContaining({ value: 65, max: 90 })]);
  });

  it('counts a restarted process once, not alongside the process it replaced', async () => {
    await h.db.query('DELETE FROM gauges');
    await h.db.query('DELETE FROM sdk_health');
    const minute = Math.floor((Date.now() - 120_000) / 60_000) * 60_000;
    const report = (instance: string, shard: number, ts: number, rssBytes: number, guilds: number) =>
      ingest(
        h.app,
        envelope(
          [
            {
              id: uuidv7(),
              ts,
              type: 'gauge_window',
              gauges: [
                { name: 'memory.rss_bytes', value: rssBytes },
                { name: 'shard.guilds', shard, value: guilds },
              ],
            },
            { id: uuidv7(), ts, type: 'sdk_health', queueDepth: 0, dropped: {}, failedFlushes: 0, internalErrors: {} },
          ],
          { source: { shards: [shard], instance } },
        ),
      );
    // The process for shard 0 keeps running; the one for shard 1 is restarted within the minute.
    await report('host:10', 0, minute + 5_000, 50e6, 30);
    await report('host:11', 1, minute + 5_000, 100e6, 40);
    await report('host:12', 1, minute + 40_000, 120e6, 41);

    const window = { from: new Date(minute).toISOString(), to: new Date(minute + 60_000).toISOString() };
    const points = async (name: string) =>
      (await query(h.app, { kind: 'gauge', name, range: window, interval: 'minute' })).json().points;
    expect(await points('memory.rss_bytes')).toEqual([expect.objectContaining({ value: 170e6 })]);
    expect(await points('shard.guilds')).toEqual([expect.objectContaining({ value: 71 })]);
    const { process } = (await query(h.app, { kind: 'reliability', range: range() })).json();
    expect(process).toMatchObject({ 'memory.rss_bytes': 170e6 });
  });
});

describe('servers and snapshots', () => {
  it('imports existing servers as a baseline, then detects joins and removals while offline', async () => {
    await h.db.query('DELETE FROM guilds');
    await h.db.query('DELETE FROM guild_events');
    await h.db.query('UPDATE apps SET shard_count = NULL, baseline_done = false');
    const a = snowflakeOnShard(0, 2, 1);
    const b = snowflakeOnShard(1, 2, 2);
    const c = snowflakeOnShard(0, 2, 3);
    const snapshot = (shard: number, guilds: string[]) => ({
      id: uuidv7(),
      ts: Date.now(),
      type: 'guild_snapshot',
      shards: [shard],
      shardCount: 2,
      guilds,
    });

    // First run: both shards report; existing servers are a baseline, not joins.
    await ingest(h.app, envelope([snapshot(0, [a]), snapshot(1, [b])]));
    let events = await h.db.query('SELECT kind FROM guild_events');
    expect(events.rowCount).toBe(0);
    const baseline = await h.db.query('SELECT count(*)::int AS n FROM guilds WHERE baseline');
    expect(baseline.rows[0].n).toBe(2);

    // Restart: on shard 0, `a` left and `c` joined while the bot was offline. Shard 1 is untouched.
    await ingest(h.app, envelope([snapshot(0, [c])]));
    events = await h.db.query(
      'SELECT guild_id::text AS id, kind, detected_at_startup AS d FROM guild_events ORDER BY kind',
    );
    expect(events.rows).toEqual([
      { id: c, kind: 1, d: true },
      { id: a, kind: 2, d: true },
    ]);
    const bRow = await h.db.query('SELECT left_at FROM guilds WHERE guild_id = $1', [b]);
    expect(bRow.rows[0].left_at).toBeNull();
  });

  it('keeps a server whose profile arrives before the last shard reports as an existing install', async () => {
    await h.db.query('DELETE FROM guilds');
    await h.db.query('DELETE FROM guild_events');
    await h.db.query('UPDATE apps SET shard_count = NULL, baseline_done = false');
    const a = snowflakeOnShard(0, 2, 31);
    const b = snowflakeOnShard(1, 2, 32);
    const snapshot = (shard: number, guilds: string[]) => ({
      id: uuidv7(),
      ts: Date.now(),
      type: 'guild_snapshot',
      shards: [shard],
      shardCount: 2,
      guilds,
    });
    const update = (guild: string) => ({
      id: uuidv7(),
      ts: Date.now(),
      type: 'guild_update',
      info: guildInfo(guild, { joinedAt: Date.now() - 3 * 86_400_000 }),
    });

    // A ShardingManager spawns shards seconds apart: shard 0 is ready and sends its profiles before shard 1 starts.
    await ingest(h.app, envelope([snapshot(0, [a])], { source: { shards: [0], instance: 'host:1' } }));
    await ingest(h.app, envelope([update(a)], { source: { shards: [0], instance: 'host:1' } }));
    await ingest(h.app, envelope([snapshot(1, [b]), update(b)], { source: { shards: [1], instance: 'host:2' } }));

    const rows = await h.db.query('SELECT guild_id::text AS id, baseline FROM guilds');
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows).toEqual(
      expect.arrayContaining([
        { id: a, baseline: true },
        { id: b, baseline: true },
      ]),
    );
    const week = { from: new Date(Date.now() - 7 * 86_400_000).toISOString(), to: new Date().toISOString() };
    const growth = (await query(h.app, { kind: 'growth', range: week })).json();
    expect(growth.sizeAtInstall).toEqual([]);
  });

  it('waits for every shard of a new layout before diffing (resharding)', async () => {
    const before = await h.db.query('SELECT count(*)::int AS n FROM guild_events');
    const x = snowflakeOnShard(0, 3, 9);
    await ingest(
      h.app,
      envelope([{ id: uuidv7(), ts: Date.now(), type: 'guild_snapshot', shards: [0], shardCount: 3, guilds: [x] }]),
    );
    const after = await h.db.query('SELECT count(*)::int AS n FROM guild_events');
    expect(after.rows[0].n).toBe(before.rows[0].n);
    const pending = await h.db.query('SELECT count(*)::int AS n FROM snapshot_pending');
    expect(pending.rows[0].n).toBe(1);
  });

  it("finishes a new shard layout without undoing the joins and leaves since each shard's snapshot", async () => {
    await h.db.query('DELETE FROM guilds');
    await h.db.query('DELETE FROM guild_events');
    await h.db.query('DELETE FROM snapshot_pending');
    await h.db.query('UPDATE apps SET shard_count = 2, baseline_done = true');
    const leaving = snowflakeOnShard(0, 4, 41);
    const joining = snowflakeOnShard(0, 4, 42);
    await h.db.query('INSERT INTO guilds (app_id, guild_id, joined_at) VALUES ($1, $2, now())', [APP_ID, leaving]);
    const at = Date.now() - 60_000;
    const snapshot = (shard: number, guilds: string[], ts: number) => ({
      id: uuidv7(ts),
      ts,
      type: 'guild_snapshot',
      shards: [shard],
      shardCount: 4,
      guilds,
    });

    // Shard 0 of the new layout reports first; then a server joins and another leaves before the last shard reports.
    await ingest(h.app, envelope([snapshot(0, [leaving], at)]));
    await ingest(
      h.app,
      envelope([
        {
          id: uuidv7(at + 10_000),
          ts: at + 10_000,
          type: 'guild_join',
          info: guildInfo(joining),
          detectedAtStartup: false,
        },
        { id: uuidv7(at + 20_000), ts: at + 20_000, type: 'guild_leave', guild: leaving, detectedAtStartup: false },
      ]),
    );
    await ingest(h.app, envelope([1, 2, 3].map((shard) => snapshot(shard, [], at + 30_000))));

    const rows = await h.db.query('SELECT guild_id::text AS id, left_at IS NULL AS active FROM guilds');
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows).toEqual(
      expect.arrayContaining([
        { id: leaving, active: false },
        { id: joining, active: true },
      ]),
    );
    const detected = await h.db.query('SELECT count(*)::int AS n FROM guild_events WHERE detected_at_startup');
    expect(detected.rows[0].n).toBe(0);
  });

  it('counts the commands a server ran before removing the bot, when both arrive in one batch', async () => {
    const { hasher, period } = await sdkHasher(h.app);
    const user = (await hasher.hash('300000000000000009', period)) as string;
    const [tried, never] = [snowflakeOnShard(0, 1, 71), snowflakeOnShard(0, 1, 72)];
    const at = Date.now() - 120_000;
    const event = (offset: number, fields: object) => ({ id: uuidv7(at + offset), ts: at + offset, ...fields });
    const join = (guild: string) =>
      event(0, { type: 'guild_join', info: guildInfo(guild, { joinedAt: at }), detectedAtStartup: false });
    const leave = (guild: string) => event(20_000, { type: 'guild_leave', guild, detectedAtStartup: false });
    const res = await ingest(
      h.app,
      envelope([
        join(tried),
        join(never),
        // Not in the order they happened: the SDK sends server events ahead of commands.
        leave(tried),
        leave(never),
        interaction(user, event(10_000, { guild: tried })),
        interaction(user, event(15_000, { guild: tried })),
        // After the removal, a user install run in those servers: not the servers using the bot.
        interaction(user, event(30_000, { guild: tried })),
        interaction(user, event(30_000, { guild: never })),
      ]),
    );
    expect(res.json()).toMatchObject({ accepted: 8 });
    const rows = await h.db.query<{ id: string; first: Date | null; last: Date | null }>(
      `SELECT guild_id::text AS id, first_command_at AS first, last_command_at AS last
         FROM guilds WHERE guild_id = ANY($1::bigint[])`,
      [[tried, never]],
    );
    const times = Object.fromEntries(rows.rows.map((r) => [r.id, [r.first?.getTime(), r.last?.getTime()]]));
    // The last command before the removal, not the first: the one after it is left out.
    expect(times).toEqual({ [tried]: [at + 10_000, at + 15_000], [never]: [undefined, undefined] });
  });

  it('ignores a snapshot of a shard outside the layout instead of counting it toward a new one', async () => {
    await h.db.query('DELETE FROM snapshot_pending');
    const res = await ingest(
      h.app,
      envelope([{ id: uuidv7(), ts: Date.now(), type: 'guild_snapshot', shards: [7], shardCount: 4, guilds: [] }]),
    );
    expect(res.json()).toMatchObject({ accepted: 1 });
    const pending = await h.db.query('SELECT count(*)::int AS n FROM snapshot_pending');
    expect(pending.rows[0].n).toBe(0);
  });

  it('records joins with a full profile and keeps Discord text as data', async () => {
    const id = snowflakeOnShard(1, 2, 20);
    const name = '<img src=x onerror=alert(1)> =HYPERLINK("x")';
    const res = await ingest(
      h.app,
      envelope([
        {
          id: uuidv7(),
          ts: Date.now(),
          type: 'guild_join',
          info: guildInfo(id, { name, memberCount: 250 }),
          detectedAtStartup: false,
        },
      ]),
    );
    expect(res.json(), res.body).toMatchObject({ accepted: 1 });
    const detail = await query(h.app, { kind: 'server', guild: id });
    expect(detail.json().profile).toMatchObject({ name, memberCount: 250, sizeAtJoin: 250 });
  });
});

describe('database server settings', () => {
  it('buckets days in UTC whatever time zone the database server uses', async () => {
    const name = (await h.db.query<{ name: string }>('SELECT current_database() AS name')).rows[0]?.name;
    await h.db.query(`ALTER DATABASE "${name}" SET timezone TO 'Pacific/Kiritimati'`);
    const db = createPool(h.config.databaseUrl, 1);
    try {
      // 23:30 UTC is already the next day in Kiritimati (UTC+14).
      const day = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
      const ts = new Date(`${day}T23:30:00Z`);
      await db.query(
        `INSERT INTO interactions (id, ts, app_id, env, kind, command, locale, user_hash, salt_period, premium, outcome)
         VALUES ($1, $2, $3, 'production', 1, 'tz_probe', 'en-GB', $4, '2026-01', false, 0)`,
        [uuidv7(ts.getTime()), ts, APP_ID, Buffer.alloc(16)],
      );
      await backfillRollups(db, new Date(`${day}T00:00:00Z`), new Date(ts.getTime() + 60_000));
      const buckets = await db.query<{ bucket: Date }>(
        "SELECT bucket FROM rollup_1d WHERE metric = 'interactions' AND dims->>'command' = 'tz_probe'",
      );
      expect(buckets.rows.map((r) => r.bucket.toISOString())).toEqual([`${day}T00:00:00.000Z`]);
    } finally {
      await h.db.query(`ALTER DATABASE "${name}" RESET timezone`);
      await db.end();
    }
  });

  it('creates the unique-user partition in every database the process uses', async () => {
    await activeSalts(h.store, APP_ID, 'month');
    await h.db.query('CREATE DATABASE shardlens_second');
    const url = new URL(h.config.databaseUrl);
    url.pathname = '/shardlens_second';
    await migrate(url.toString());
    const db = createPool(url.toString(), 1);
    try {
      await db.query('INSERT INTO apps (app_id) VALUES ($1)', [APP_ID]);
      const [salt] = await activeSalts(new PostgresStore(db), APP_ID, 'month');
      const partition = await db.query<{ t: string | null }>('SELECT to_regclass($1) AS t', [
        `uniques_${periodIdent(salt?.period ?? '')}`,
      ]);
      expect(partition.rows[0]?.t).not.toBeNull();
    } finally {
      await db.end();
    }
  });
});

describe('salt lifecycle', () => {
  it('destroys expired salts: final counts kept, hashes deleted, secret NULL, partition dropped', async () => {
    await h.db.query(
      `INSERT INTO salts (app_id, period, secret, period_end, destroy_after)
       VALUES ($1, '2020-01', '\\x00', '2020-02-01', '2020-02-08') ON CONFLICT DO NOTHING`,
      [APP_ID],
    );
    await h.db.query(`CREATE TABLE IF NOT EXISTS uniques_2020_01 PARTITION OF uniques FOR VALUES IN ('2020-01')`);
    await h.db.query(
      `INSERT INTO uniques (app_id, period, day, scope, scope_key, user_hash)
       VALUES ($1, '2020-01', '2020-01-15', 'global', '*', '\\x01')`,
      [APP_ID],
    );
    const destroyed = await runSalts(h.db, new Date());
    expect(destroyed).toContain(`${APP_ID}:2020-01`);
    const salt = await h.db.query("SELECT secret, destroyed_at FROM salts WHERE period = '2020-01'");
    expect(salt.rows[0].secret).toBeNull();
    expect(salt.rows[0].destroyed_at).not.toBeNull();
    const part = await h.db.query("SELECT to_regclass('uniques_2020_01') AS t");
    expect(part.rows[0].t).toBeNull();
    const counts = await h.db.query(
      "SELECT users, final FROM unique_counts WHERE grain = 'month' AND start_day = '2020-01-01' AND scope = 'global'",
    );
    expect(counts.rows[0]).toEqual({ users: 1, final: true });
  });
});

describe('retention', () => {
  it('drops raw partitions past their retention', async () => {
    await h.db.query("SELECT shardlens_ensure_daily_partitions(ARRAY['interactions'], '2020-01-01', '2020-01-01')");
    await runRetention(h.db, new Date());
    const res = await h.db.query("SELECT to_regclass('interactions_20200101') AS t");
    expect(res.rows[0].t).toBeNull();
  });

  it('forgets the SDK health of bot processes that stopped reporting a month ago', async () => {
    await h.db.query(
      `INSERT INTO sdk_health (app_id, instance, ts, queue_depth, dropped, failed_flushes, internal_errors)
       VALUES ($1, 'gone:1', now() - interval '31 days', 0, '{}', 0, '{}'), ($1, 'alive:2', now(), 0, '{}', 0, '{}')`,
      [APP_ID],
    );
    await runRetention(h.db, new Date());
    const left = await h.db.query<{ instance: string }>(
      "SELECT instance FROM sdk_health WHERE instance IN ('gone:1', 'alive:2')",
    );
    expect(left.rows.map((r) => r.instance)).toEqual(['alive:2']);
  });

  it("reads raw rows for as long as the app's raw retention keeps them, no longer and no shorter", async () => {
    const DAY = 86_400_000;
    const old = Date.now() - 50 * DAY;
    const day = new Date(old).toISOString().slice(0, 10);
    await h.db.query("SELECT shardlens_ensure_daily_partitions(ARRAY['interactions'], $1::date, $1::date)", [day]);
    // Ingest accepts 35 days back at most, but rows collected live stay for the whole retention.
    await h.db.query(
      `INSERT INTO interactions (id, ts, app_id, env, kind, command, locale, user_hash, salt_period, premium, outcome)
       VALUES ($1, $2, $3, 'production', 1, 'archive', 'en-GB', $4, $5, false, 0)`,
      [uuidv7(old), new Date(old), APP_ID, Buffer.alloc(16, 7), day.slice(0, 7)],
    );
    const range = { from: new Date(Date.now() - 60 * DAY).toISOString(), to: new Date().toISOString() };
    const detail = async () => (await query(h.app, { kind: 'command', name: 'archive', range })).json();
    try {
      await h.db.query('UPDATE apps SET raw_retention_days = 90 WHERE app_id = $1', [APP_ID]);
      const kept = await detail();
      expect(kept.totals.runs).toBe(1);
      expect(kept.from).toBe(range.from);
      await h.db.query('UPDATE apps SET raw_retention_days = 7 WHERE app_id = $1', [APP_ID]);
      const cut = await detail();
      expect(Date.parse(cut.from)).toBeGreaterThan(Date.now() - 7 * DAY - 60_000);
    } finally {
      await h.db.query('UPDATE apps SET raw_retention_days = 35 WHERE app_id = $1', [APP_ID]);
      await h.db.query(`DROP TABLE IF EXISTS "interactions_${day.replace(/-/g, '')}"`);
    }
  });
});

describe('dashboard login', () => {
  it('exchanges a read key for an HttpOnly session, and needs the CSRF header', async () => {
    const noHeader = await h.app.inject({ method: 'POST', url: '/auth/read-key', payload: { key: READ_KEY } });
    expect(noHeader.statusCode).toBe(403);
    const bad = await h.app.inject({
      method: 'POST',
      url: '/auth/read-key',
      headers: { 'x-shardlens-csrf': '1' },
      payload: { key: 'slk_read_nope' },
    });
    expect(bad.statusCode).toBe(401);
    const ok = await h.app.inject({
      method: 'POST',
      url: '/auth/read-key',
      headers: { 'x-shardlens-csrf': '1' },
      payload: { key: READ_KEY },
    });
    expect(ok.statusCode).toBe(200);
    const cookie = ok.cookies.find((c) => c.name === 'shardlens_session');
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax' });
    const me = await h.app.inject({ method: 'GET', url: '/auth/me', cookies: { shardlens_session: cookie!.value } });
    expect(me.json()).toMatchObject({ authenticated: true, method: 'read_key' });
    const q = await h.app.inject({
      method: 'POST',
      url: '/v1/query',
      cookies: { shardlens_session: cookie!.value },
      payload: { kind: 'overview' },
    });
    expect(q.statusCode).toBe(200);
  });

  it('signs in with Discord: state checked, PKCE sent, the secret to Discord only, no token kept', async () => {
    const admin = '334455667788990022';
    const app = await buildServer({
      store: h.store,
      db: h.db,
      live: h.live,
      keys: new KeyStore(h.store),
      config: { ...h.config, discord: { clientId: APP_ID, clientSecret: 'shh-client-secret' }, extraAdmins: [admin] },
    });
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    let tokenAnswer = () => Response.json({ access_token: 'discord-access-token', token_type: 'Bearer' });
    const discord = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === 'https://discord.com/api/oauth2/token') return tokenAnswer();
      if (url === 'https://discord.com/api/v10/users/@me') return Response.json({ id: admin, username: 'someone' });
      throw new Error(`unexpected request to ${url}`);
    });
    try {
      const start = await app.inject({ method: 'GET', url: '/auth/discord' });
      expect(start.statusCode).toBe(302);
      const authorize = new URL(String(start.headers.location));
      expect(authorize.origin + authorize.pathname).toBe('https://discord.com/oauth2/authorize');
      const asked = Object.fromEntries(authorize.searchParams);
      expect(asked).toMatchObject({
        response_type: 'code',
        client_id: APP_ID,
        redirect_uri: 'https://stats.example.com/auth/discord/callback',
        scope: 'identify',
        code_challenge_method: 'S256',
      });
      expect(asked.state).toMatch(/^[\w-]{43}$/);
      const cookies = Object.fromEntries(start.cookies.map((c) => [c.name, c.value]));
      const callback = (state: string) =>
        app.inject({ method: 'GET', url: `/auth/discord/callback?code=the-code&state=${state}`, cookies });

      // A callback with a state this browser was never given goes nowhere near Discord.
      const forged = await callback('a'.repeat(43));
      expect(forged.headers.location).toBe('/login?error=invalid_state');
      expect(calls).toEqual([]);

      const done = await callback(asked.state as string);
      expect(done.statusCode).toBe(302);
      expect(done.headers.location).toBe('/');
      const exchange = calls.find((c) => c.url === 'https://discord.com/api/oauth2/token');
      const sent = new URLSearchParams(exchange?.init?.body as URLSearchParams);
      expect(Object.fromEntries(sent)).toMatchObject({
        grant_type: 'authorization_code',
        code: 'the-code',
        redirect_uri: 'https://stats.example.com/auth/discord/callback',
      });
      // PKCE: the verifier sent now hashes to the challenge sent at the start.
      const verifier = sent.get('code_verifier') as string;
      expect(createHash('sha256').update(verifier).digest('base64url')).toBe(asked.code_challenge);
      const headers = new Headers(exchange?.init?.headers);
      expect(headers.get('authorization')).toBe(
        `Basic ${Buffer.from(`${APP_ID}:shh-client-secret`).toString('base64')}`,
      );
      expect(exchange?.init?.redirect).toBe('error');
      const profile = calls.find((c) => c.url.endsWith('/users/@me'));
      expect(new Headers(profile?.init?.headers).get('authorization')).toBe('Bearer discord-access-token');

      const session = done.cookies.find((c) => c.name === 'shardlens_session');
      expect(session).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax' });
      const me = await app.inject({ method: 'GET', url: '/auth/me', cookies: { shardlens_session: session!.value } });
      expect(me.json()).toMatchObject({ authenticated: true, method: 'discord' });
      const stored = await h.db.query('SELECT * FROM sessions');
      expect(JSON.stringify(stored.rows)).not.toContain('discord-access-token');

      // Discord refuses the code (used twice, or expired): no session, and only the error's name is known.
      tokenAnswer = () => Response.json({ error: 'invalid_grant' }, { status: 400 });
      const refused = await callback(asked.state as string);
      expect(refused.headers.location).toBe('/login?error=discord_error');
      expect(refused.cookies.find((c) => c.name === 'shardlens_session')).toBeUndefined();
    } finally {
      discord.mockRestore();
      await app.close();
    }
  });

  it('sends a strict Content-Security-Policy', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/healthz' });
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain('https://cdn.discordapp.com');
    expect(csp).not.toContain('data:');
    expect(csp).not.toContain('unsafe');
  });
});

describe('abuse limits', () => {
  const get = (url: string, remoteAddress: string) => h.app.inject({ method: 'GET', url, remoteAddress });

  it('turns away a caller without a key before reading the body', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/ingest',
      headers: { 'content-type': 'application/json' },
      payload: Buffer.alloc(2 * 1024 * 1024, 32),
    });
    // 401, not the 413 an oversized body gets once it has been read.
    expect(res.statusCode).toBe(401);
  });

  it('limits every route per address, including routes without a limit of their own', async () => {
    const noisy = '203.0.113.7';
    await Promise.all(Array.from({ length: 1_200 }, () => get('/healthz', noisy)));
    const limited = await get('/healthz', noisy);
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ error: 'rate_limited' });
    expect(limited.headers['retry-after']).toBeDefined();
    expect((await get('/v1/meta', noisy)).statusCode).toBe(429);
    expect((await get('/healthz', '203.0.113.8')).statusCode).toBe(200);
  });

  it('counts a visitor behind one proxy by the address the proxy saw, not one the visitor wrote', async () => {
    const behindProxy = await buildServer({
      store: h.store,
      db: h.db,
      live: h.live,
      keys: new KeyStore(h.store),
      config: { ...h.config, trustProxy: 1 },
    });
    try {
      // A proxy that adds to X-Forwarded-For: the left-most entries are whatever the visitor sent.
      const attempt = (i: number) =>
        behindProxy.inject({
          method: 'POST',
          url: '/auth/read-key',
          remoteAddress: '10.0.0.2',
          headers: { 'x-forwarded-for': `198.51.100.${i}, 192.0.2.44`, 'x-shardlens-csrf': '1' },
          payload: { key: `slk_read_${'Z'.repeat(43)}` },
        });
      const statuses: number[] = [];
      for (let i = 0; i < 25; i++) statuses.push((await attempt(i)).statusCode);
      expect(statuses).toContain(429);
    } finally {
      await behindProxy.close();
    }
  });

  it('keeps URLs, and so anything pasted into one, out of the logs unless it runs at debug level', async () => {
    const logged = async (logLevel: string) => {
      const lines: string[] = [];
      const app = await buildServer({
        store: h.store,
        db: h.db,
        live: h.live,
        keys: new KeyStore(h.store),
        config: { ...h.config, logLevel },
        logStream: { write: (line) => void lines.push(line) },
      });
      await app.inject({ method: 'GET', url: `/v1/meta?key=${READ_KEY}` });
      await app.inject({ method: 'GET', url: `/no-such-page?key=${READ_KEY}` });
      await app.close();
      return lines.join('');
    };
    expect(await logged('info')).not.toContain(READ_KEY);
    expect(await logged('debug')).toContain('/v1/meta?key=');
  });

  it('answers an unexpected failure with a request ID and nothing about the cause', async () => {
    const broken = {
      query: async () => {
        throw new Error('connection to 10.0.0.5 refused');
      },
    } as unknown as typeof h.db;
    const store = new PostgresStore(broken);
    const app = await buildServer({ store, db: broken, live: h.live, keys: new KeyStore(store), config: h.config });
    const res = await app.inject({ method: 'GET', url: '/v1/meta', headers: { authorization: `Bearer ${READ_KEY}` } });
    await app.close();
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'internal', requestId: expect.any(String) });
    expect(res.body).not.toContain('10.0.0.5');
  });

  it('refuses input the database could not store instead of failing on it', async () => {
    const range = { from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date().toISOString() };
    expect((await query(h.app, { kind: 'command', name: 'a\u0000b', range })).statusCode).toBe(400);
    expect((await query(h.app, { kind: 'server', guild: '99999999999999999999' })).statusCode).toBe(400);
    const nested = await h.app.inject({
      method: 'POST',
      url: '/v1/query',
      headers: { authorization: `Bearer ${READ_KEY}`, 'content-type': 'application/json' },
      payload: `${'['.repeat(20_000)}${']'.repeat(20_000)}`,
    });
    expect(nested.statusCode).toBe(400);

    const { hasher, period } = await sdkHasher(h.app);
    const user = (await hasher.hash('565656565656565656', period))!;
    const res = await ingest(
      h.app,
      envelope([
        interaction(user, { guild: '99999999999999999999' }),
        interaction(user, { command: 'a\u0000b' }),
        interaction(user),
      ]),
    );
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({
      accepted: 1,
      rejected: [
        { index: 0, reason: 'invalid_event' },
        { index: 1, reason: 'invalid_event' },
      ],
    });
  });

  it('answers 400, not 500, when the database refuses a value, so an SDK does not retry it forever', async () => {
    const refusing = {
      query: async () => {
        throw Object.assign(new Error('value "1e400" is out of range'), { code: '22003', severity: 'ERROR' });
      },
    } as unknown as typeof h.db;
    const store = new PostgresStore(refusing);
    const app = await buildServer({ store, db: refusing, live: h.live, keys: new KeyStore(store), config: h.config });
    const res = await app.inject({ method: 'GET', url: '/v1/meta', headers: { authorization: `Bearer ${READ_KEY}` } });
    await app.close();
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_request' });
  });

  it('gives a client 30 seconds to send a request, so a slow trickle cannot hold a connection open', () => {
    expect(h.app.server.requestTimeout).toBe(30_000);
    expect(h.app.server.headersTimeout).toBeLessThanOrEqual(60_000);
  });

  it('does not log an error when the client simply went away', async () => {
    const lines: string[] = [];
    const gone = {
      query: async () => {
        throw Object.assign(new Error('Premature close'), { code: 'ERR_STREAM_PREMATURE_CLOSE' });
      },
    } as unknown as typeof h.db;
    const app = await buildServer({
      store: new PostgresStore(gone),
      db: gone,
      live: h.live,
      keys: new KeyStore(new PostgresStore(gone)),
      config: { ...h.config, logLevel: 'info' },
      logStream: { write: (line) => void lines.push(line) },
    });
    const res = await app.inject({ method: 'GET', url: '/v1/meta', headers: { authorization: `Bearer ${READ_KEY}` } });
    await app.close();
    expect(res.statusCode).not.toBe(500);
    expect(lines.join('')).not.toContain('request failed');
  });

  it('limits unknown paths too', async () => {
    const scanner = '203.0.113.9';
    expect((await get('/v1/no-such-route', scanner)).statusCode).toBe(404);
    await Promise.all(Array.from({ length: 1_200 }, () => get('/v1/no-such-route', scanner)));
    expect((await get('/v1/no-such-route', scanner)).statusCode).toBe(429);
  });
});

describe('keys from the environment', () => {
  it('revokes the key a variable held before, and only when a new value arrives', async () => {
    const [first, second] = ['E', 'F'].map((c) => `slk_read_${c.repeat(43)}`) as [string, string];
    const reads = async (key: string) =>
      (await h.app.inject({ method: 'GET', url: '/v1/meta', headers: { authorization: `Bearer ${key}` } })).statusCode;
    await seedKey(h.store, APP_ID, first, 'SHARDLENS_READ_KEY');
    const session = await h.app.inject({
      method: 'POST',
      url: '/auth/read-key',
      headers: { 'x-shardlens-csrf': '1' },
      payload: { key: first },
    });
    expect(session.statusCode).toBe(200);
    expect(await reads(first)).toBe(200);

    // The owner replaces a leaked key in .env and restarts.
    await seedKey(h.store, APP_ID, second, 'SHARDLENS_READ_KEY');
    const keys = new KeyStore(h.store);
    expect(await keys.verify(first, 'read')).toBeUndefined();
    expect(await keys.verify(second, 'read')).toBeDefined();
    const signedIn = await h.db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM sessions s JOIN api_keys k ON k.id = s.key_id WHERE k.revoked_at IS NOT NULL',
    );
    expect(signedIn.rows[0]?.n).toBe(0);
    const audit = await h.db.query<{ details: { by: string; variable: string } }>(
      "SELECT details FROM admin_audit WHERE action = 'key_revoke' AND details->>'by' = 'environment'",
    );
    expect(audit.rows.map((r) => r.details)).toEqual([expect.objectContaining({ variable: 'SHARDLENS_READ_KEY' })]);

    // An instance still started with the old value can't take the new one away, nor bring the old one back.
    await seedKey(h.store, APP_ID, first, 'SHARDLENS_READ_KEY');
    expect(await new KeyStore(h.store).verify(first, 'read')).toBeUndefined();
    expect(await new KeyStore(h.store).verify(second, 'read')).toBeDefined();
    // Keys of other variables, and keys made in Settings, are left alone.
    expect(await reads(READ_KEY)).toBe(200);
  });
});

describe('dashboard files', () => {
  it('serves the dashboard for its pages, and 404 for a file that does not exist', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shardlens-dashboard-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Shardlens</title>');
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'assets', 'index-abc123.js'), 'console.log(1)');
    writeFileSync(join(dir, 'favicon.svg'), '<svg/>');
    const app = await buildServer({
      store: h.store,
      db: h.db,
      live: h.live,
      keys: new KeyStore(h.store),
      config: { ...h.config, dashboardDir: dir },
    });
    try {
      const page = await app.inject({ method: 'GET', url: '/commands/ticket' });
      expect(page.statusCode).toBe(200);
      expect(page.headers['content-type']).toContain('text/html');
      // A command named with a dot is a page, not a file, when the link is opened or the page reloaded.
      for (const url of ['/commands/say.hello', '/commands/Info%20v2.0', '/commands/stats.json']) {
        const res = await app.inject({ method: 'GET', url });
        expect(res.statusCode, url).toBe(200);
        expect(res.headers['content-type'], url).toContain('text/html');
      }
      // After an upgrade the page must not come from a cache: it names this build's scripts.
      for (const url of ['/', '/commands/ticket', '/index.html']) {
        expect((await app.inject({ method: 'GET', url })).headers['cache-control'], url).toBe('no-cache');
      }
      const asset = await app.inject({ method: 'GET', url: '/assets/index-abc123.js' });
      expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      expect((await app.inject({ method: 'GET', url: '/favicon.svg' })).headers['cache-control']).toBe(
        'public, max-age=3600',
      );
      // A script from a previous build must not be answered with HTML.
      for (const url of ['/assets/index-old.js', '/favicon.ico', '/v1/no-such-route']) {
        const res = await app.inject({ method: 'GET', url });
        expect(res.statusCode, url).toBe(404);
        expect(res.json()).toEqual({ error: 'not_found' });
      }
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('serves no page with the dashboard off, and the API as before', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shardlens-dashboard-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Shardlens</title>');
    const app = await buildServer({
      store: h.store,
      db: h.db,
      live: h.live,
      keys: new KeyStore(h.store),
      config: { ...h.config, dashboardDir: dir, dashboard: false },
    });
    try {
      const root = await app.inject({ method: 'GET', url: '/' });
      expect(root.json()).toEqual({ name: 'shardlens-collector', dashboard: 'off' });
      for (const url of ['/commands/ticket', '/index.html', '/settings']) {
        const res = await app.inject({ method: 'GET', url });
        expect(res.statusCode, url).toBe(404);
        expect(res.headers['content-type'], url).toContain('application/json');
      }
      const meta = await app.inject({
        method: 'GET',
        url: '/v1/meta',
        headers: { authorization: `Bearer ${READ_KEY}` },
      });
      expect(meta.statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
