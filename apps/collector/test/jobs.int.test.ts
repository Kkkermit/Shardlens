import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { uuidv7 } from '@shardlens/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, transaction } from '../src/db.js';
import {
  dropExpiredPartitions,
  ensurePartitions,
  ensurePartitionsPatiently,
} from '../src/storage/postgres/partitions.js';
import { activeSalts, ensureSalt, UPCOMING_SALT_MS } from '../src/storage/salts.js';
import { APP_ID, type Harness, startHarness } from './harness.js';

const MINUTE = 60_000;
const DAY = 86_400_000;
const minuteOf = (ms: number) => Math.floor(ms / MINUTE) * MINUTE;

let h: Harness;

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h?.close();
});

const custom = (name: string, ts: number) =>
  h.db.query('INSERT INTO custom_events (id, ts, app_id, name) VALUES ($1, $2, $3, $4)', [
    uuidv7(ts),
    new Date(ts),
    APP_ID,
    name,
  ]);

async function rolledUp(name: string, bucket: number): Promise<number> {
  const res = await h.db.query<{ n: number }>(
    'SELECT coalesce(sum(count), 0)::int AS n FROM rollup_1m WHERE metric = $1 AND bucket = $2',
    [`custom.${name}`, new Date(bucket)],
  );
  return res.rows[0]?.n ?? 0;
}

describe('rollup runs', () => {
  it('rolls up an event that arrived just under 2 minutes late, too young to be marked dirty', async () => {
    const arrived = Date.now();
    const ts = arrived - 115_000;
    await custom('almost_late', ts);
    // The next run, even one that starts a while after the event arrived.
    await h.store.jobs.runRollups(new Date(arrived + 90_000));
    expect(await rolledUp('almost_late', minuteOf(ts))).toBe(1);
  });

  it('reaches back to before the previous run when runs fall behind', async () => {
    const previousRun = Date.now();
    const ts = previousRun - 100_000;
    await custom('behind', ts);
    // The scheduler was busy: this run starts ten minutes after the previous one.
    await h.store.jobs.runRollups(new Date(previousRun + 10 * MINUTE), { since: new Date(previousRun) });
    expect(await rolledUp('behind', minuteOf(ts))).toBe(1);
  });

  it('keeps the dirty mark of a late event that lands while a run is working', async () => {
    const bucket = minuteOf(Date.now() - 30 * MINUTE);
    // What ingest does for a late event: the row, then the minute's mark if there isn't one.
    const late = (offset: number) =>
      transaction(h.db, async (tx) => {
        await tx.query('INSERT INTO custom_events (id, ts, app_id, name) VALUES ($1, $2, $3, $4)', [
          uuidv7(bucket + offset),
          new Date(bucket + offset),
          APP_ID,
          'raced',
        ]);
        await tx.query('INSERT INTO dirty_buckets (app_id, bucket) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
          APP_ID,
          new Date(bucket),
        ]);
      });
    await late(1_000);
    // A slow day rollup holds the run back while a second late event for the same minute commits.
    const blocker = await h.db.connect();
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE rollup_1d IN EXCLUSIVE MODE');
    const run = h.store.jobs.runRollups();
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await late(2_000);
    await blocker.query('COMMIT');
    blocker.release();
    await run;
    await h.store.jobs.runRollups();
    expect(await rolledUp('raced', bucket)).toBe(2);
  });

  it('skips rows the database cannot aggregate, and still rolls up every other metric', async () => {
    const ts = Date.now() - 20_000;
    for (let i = 0; i < 2; i++) {
      // Two retry-after values whose sum overflows a double, and two histograms whose sum passes int4.
      await h.db.query(
        `INSERT INTO rate_limits (id, ts, app_id, scope, global, route, method, retry_after)
         VALUES ($1, $2, $3, 'user', false, '/poison', 'POST', 1e308)`,
        [uuidv7(ts), new Date(ts), APP_ID],
      );
      const hist = Array.from({ length: 40 }, (_, b) => (b === 16 ? 2 ** 31 - 1 : 0));
      await h.db.query(
        `INSERT INTO rest_calls (event_id, row_no, ts, app_id, method, route, status, count, retries, hist)
         VALUES ($1, 0, $2, $3, 'GET', '/saturated', 200, 1, 0, $4)`,
        [uuidv7(ts), new Date(ts), APP_ID, hist],
      );
    }
    await custom('beside_poison', ts);
    try {
      const { skipped } = await h.store.jobs.runRollups();
      expect(skipped.length).toBeGreaterThan(0);
      expect(await rolledUp('beside_poison', minuteOf(ts))).toBe(1);
      const rest = await h.db.query<{ hist: number[] }>(
        "SELECT hist FROM rollup_1m WHERE metric = 'rest.calls' AND dims->>'route' = '/saturated'",
      );
      expect(rest.rows[0]?.hist[16]).toBe(2 ** 31 - 1);
    } finally {
      await h.db.query("DELETE FROM rate_limits WHERE route = '/poison'");
    }
  });
});

describe('partitions', () => {
  it('lets collectors starting together on one database create the same partitions', async () => {
    const pools = [1, 2, 3].map(() => createPool(h.config.databaseUrl, 1));
    const ahead = new Date(Date.now() + 400 * DAY);
    try {
      const created = await Promise.all(
        pools.map((pool) => ensurePartitions(pool, ahead, { rawDays: 1, auditDays: 1 })),
      );
      expect(created.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    } finally {
      await Promise.all(pools.map((pool) => pool.end()));
    }
  });

  it('gives up creating a partition behind a long query instead of holding ingest up', async () => {
    const reader = await h.db.connect();
    await reader.query('BEGIN');
    await reader.query('SELECT count(*) FROM interactions');
    try {
      const started = Date.now();
      await expect(
        ensurePartitionsPatiently(h.db, new Date(Date.now() + 500 * DAY), { rawDays: 1, auditDays: 1 }),
      ).rejects.toMatchObject({ code: '55P03' });
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      await reader.query('ROLLBACK');
      reader.release();
    }
  });

  it('leaves a busy expired partition for a later run instead of waiting for it', async () => {
    const old = Date.now() - 80 * DAY;
    await ensurePartitions(h.db, new Date(old), { rawDays: 1, auditDays: 1 });
    const busyName = `interactions_${new Date(old).toISOString().slice(0, 10).replace(/-/g, '')}`;
    const reader = await h.db.connect();
    await reader.query('BEGIN');
    await reader.query(`SELECT count(*) FROM "${busyName}"`);
    const retention = { rawDays: 35, auditDays: 30 };
    try {
      const first = await dropExpiredPartitions(h.db, new Date(), retention);
      expect(first.busy).toEqual([busyName]);
      expect(first.dropped.length).toBeGreaterThan(0);
    } finally {
      await reader.query('ROLLBACK');
      reader.release();
    }
    const second = await dropExpiredPartitions(h.db, new Date(), retention);
    expect(second).toEqual({ dropped: [busyName], busy: [] });
  });
});

describe('unique users', () => {
  const users = (n: number) => Array.from({ length: n }, () => randomBytes(16));
  const seen = async (period: string, day: string, hashes: Buffer[]) => {
    for (const hash of hashes) {
      await h.db.query(
        "INSERT INTO uniques (app_id, period, day, scope, scope_key, user_hash) VALUES ($1, $2, $3, 'global', '', $4)",
        [APP_ID, period, day, hash],
      );
    }
  };
  const weekRow = async (monday: string) =>
    (
      await h.db.query<{ users: number }>(
        "SELECT users FROM unique_counts WHERE app_id = $1 AND grain = 'week' AND scope = 'global' AND start_day = $2",
        [APP_ID, monday],
      )
    ).rows[0];

  it('counts a week only when it lies inside one salt period, and never rewrites a final count', async () => {
    await ensureSalt(h.store, APP_ID, '2026-11');
    await ensureSalt(h.store, APP_ID, '2026-12');
    // 9–15 November is inside November. 30 November – 6 December spans two salts, so its users can't be combined.
    await seen('2026-11', '2026-11-10', users(4));
    await seen('2026-11', '2026-11-30', users(10));
    await seen('2026-12', '2026-12-01', users(3));
    await h.store.jobs.runUniques(APP_ID);
    expect(await weekRow('2026-11-09')).toEqual({ users: 4 });
    expect(await weekRow('2026-11-30')).toBeUndefined();

    const month = async () =>
      (
        await h.db.query<{ users: number; final: boolean }>(
          `SELECT users, final FROM unique_counts
            WHERE app_id = $1 AND grain = 'month' AND scope = 'global' AND start_day = '2026-11-01'`,
          [APP_ID],
        )
      ).rows[0];
    await h.store.jobs.runUniques(APP_ID, '2026-11', true);
    expect(await month()).toEqual({ users: 14, final: true });
    await h.db.query("DELETE FROM uniques WHERE app_id = $1 AND period = '2026-11' AND day = '2026-11-30'", [APP_ID]);
    await h.store.jobs.runUniques(APP_ID);
    expect(await month()).toEqual({ users: 14, final: true });
  });
});

describe('salts', () => {
  it("hands out the next period's salt in the last minutes of a period, after the others", async () => {
    const end = Date.UTC(2026, 11, 1);
    const near = await activeSalts(h.store, APP_ID, 'month', new Date(end - 2 * MINUTE));
    expect(near[0]?.period).toBe('2026-11');
    expect(near.at(-1)?.period).toBe('2026-12');
    const earlier = await activeSalts(h.store, APP_ID, 'month', new Date(end - UPCOMING_SALT_MS - MINUTE));
    expect(earlier.map((s) => s.period)).not.toContain('2026-12');
  });
});

describe('upgrading from rollups cut in the server time zone', () => {
  const rows = async (table: 'rollup_1h' | 'rollup_1d') =>
    (
      await h.db.query<{ bucket: Date; count: number }>(
        `SELECT bucket, count FROM ${table} WHERE metric = 'custom.tz_upgrade' ORDER BY bucket`,
      )
    ).rows.map((r) => [r.bucket.toISOString(), r.count]);

  it('moves hourly and daily buckets onto UTC without counting anything twice', async () => {
    const at = (ms: number, hhmm: string) =>
      new Date(ms + Number(hhmm.slice(0, 2)) * 3_600_000 + Number(hhmm.slice(3)) * MINUTE);
    const add = (table: string, bucket: Date, count: number) =>
      h.db.query(
        `INSERT INTO ${table} (app_id, bucket, metric, dims_hash, dims, count)
         VALUES ($1, $2, 'custom.tz_upgrade', sha256(convert_to('{}', 'UTF8')), '{}', $3)`,
        [APP_ID, bucket, count],
      );
    const today = Math.floor(Date.now() / DAY) * DAY;
    const recent = today - 2 * DAY; // minute rollups still exist
    const older = today - 60 * DAY; // only hourly rollups
    const oldest = today - 400 * DAY; // only daily rollups
    // A 1.0 collector on a server in Asia/Kolkata (UTC+5:30) cut hours at :30 and days at 18:30 UTC.
    await add('rollup_1m', at(recent, '14:40'), 3);
    await add('rollup_1m', at(recent, '15:10'), 2);
    await add('rollup_1h', at(recent, '14:30'), 5);
    await add('rollup_1d', at(recent - DAY, '18:30'), 5);
    await add('rollup_1h', at(older, '10:30'), 4);
    await add('rollup_1d', at(older - DAY, '18:30'), 4);
    await add('rollup_1d', at(oldest - DAY, '18:30'), 7);
    // After the upgrade, the new collector's UTC buckets.
    await add('rollup_1h', at(recent, '15:00'), 2);
    await add('rollup_1d', new Date(recent), 2);
    await add('rollup_1h', at(older, '11:00'), 1);
    await add('rollup_1d', new Date(older), 1);
    await add('rollup_1d', new Date(oldest), 2);

    const client = await h.db.connect();
    try {
      await client.query('BEGIN');
      await client.query(readFileSync(new URL('../migrations/010_utc_rollup_buckets.sql', import.meta.url), 'utf8'));
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    expect(await rows('rollup_1h')).toEqual([
      [at(older, '11:00').toISOString(), 5],
      [at(recent, '14:00').toISOString(), 3],
      [at(recent, '15:00').toISOString(), 2],
    ]);
    expect(await rows('rollup_1d')).toEqual([
      [new Date(oldest).toISOString(), 9],
      [new Date(older).toISOString(), 5],
      [new Date(recent).toISOString(), 5],
    ]);
  });
});
