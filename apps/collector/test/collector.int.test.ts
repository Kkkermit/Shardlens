import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { bucketOf, uuidv7 } from '@shardlens/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { evaluateMetric } from '../src/jobs/alerts.js';
import { runRollups, runUniques } from '../src/jobs/rollups.js';
import { runRetention, runSalts } from '../src/jobs/scheduler.js';
import { KeyStore } from '../src/security/auth.js';
import { buildServer } from '../src/server.js';
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
    expect(await evaluateMetric(h.db, APP_ID, 'missed_deadline_rate', 3_600)).toBeCloseTo((100 * 5) / 105);
    const detail = (await query(h.app, { kind: 'command', name: 'ping', range: range() })).json();
    expect(detail.totals).toMatchObject({ runs: 5 });
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

  it('keeps URLs, and so anything pasted into one, out of the logs unless it runs at debug level', async () => {
    const logged = async (logLevel: string) => {
      const lines: string[] = [];
      const app = await buildServer({
        db: h.db,
        live: h.live,
        keys: new KeyStore(h.db),
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
    const app = await buildServer({ db: broken, live: h.live, keys: new KeyStore(broken), config: h.config });
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
    const app = await buildServer({ db: refusing, live: h.live, keys: new KeyStore(refusing), config: h.config });
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
      db: gone,
      live: h.live,
      keys: new KeyStore(gone),
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

describe('dashboard files', () => {
  it('serves the dashboard for its pages, and 404 for a file that does not exist', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shardlens-dashboard-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Shardlens</title>');
    const app = await buildServer({
      db: h.db,
      live: h.live,
      keys: new KeyStore(h.db),
      config: { ...h.config, dashboardDir: dir },
    });
    try {
      const page = await app.inject({ method: 'GET', url: '/commands/ticket' });
      expect(page.statusCode).toBe(200);
      expect(page.headers['content-type']).toContain('text/html');
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
});
