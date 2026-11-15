import { randomBytes } from 'node:crypto';
import { type Db, type Tx, transaction } from '../db.js';
import {
  nextPeriodLabel,
  periodBounds,
  periodIdent,
  periodLabel,
  previousPeriodLabel,
  SALT_GRACE_MS,
  type SaltPeriod,
} from './periods.js';

/** Raw tables partitioned by day, and how many days of partitions to keep by default. */
const DAILY_TABLES = [
  'interactions',
  'interaction_errors',
  'rest_calls',
  'rest_invalid',
  'rate_limits',
  'custom_events',
  'webhook_events',
  'gauges',
  'audit_log',
  'rollup_1m',
] as const;

export const RETENTION_DAYS: Record<(typeof DAILY_TABLES)[number], number | 'raw' | 'audit'> = {
  interactions: 'raw',
  interaction_errors: 'raw',
  rest_calls: 'raw',
  rest_invalid: 'raw',
  rate_limits: 'raw',
  custom_events: 'raw',
  webhook_events: 'raw',
  gauges: 30,
  audit_log: 'audit',
  rollup_1m: 14,
};

/** Default raw retention, and the most days of raw history ingest will ever accept. */
export const ACCEPT_BACK_DAYS = 35;
const AHEAD_DAYS = 7;

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Attaching or dropping a partition locks its parent table against everything, ingest included, and has to wait for
 * the queries already reading it. The scheduled jobs give up after this long and try again a minute later, instead of
 * holding ingest up behind a long dashboard query.
 */
const JOB_LOCK_TIMEOUT = '2s';
/** PostgreSQL's `lock_not_available`, raised when `lock_timeout` runs out. */
const LOCK_NOT_AVAILABLE = '55P03';

/**
 * Creates daily partitions for each table from the start of its retention window to 7 days ahead, so late events
 * within retention always have a partition and nothing is recreated only to be dropped again. Idempotent, and safe
 * for collectors starting together (the SQL function takes a lock).
 */
export async function ensurePartitions(
  db: Db | Tx,
  now = new Date(),
  retention: { rawDays: number; auditDays: number } = { rawDays: ACCEPT_BACK_DAYS, auditDays: 30 },
): Promise<number> {
  const to = day(now.getTime() + AHEAD_DAYS * 86_400_000);
  const groups = new Map<number, string[]>();
  for (const table of DAILY_TABLES) {
    const setting = RETENTION_DAYS[table];
    const days = setting === 'raw' ? retention.rawDays : setting === 'audit' ? retention.auditDays : setting;
    groups.set(days, [...(groups.get(days) ?? []), table]);
  }
  let created = 0;
  for (const [days, tables] of groups) {
    const from = day(now.getTime() - (days - 1) * 86_400_000);
    const res = await db.query<{ n: number }>(
      'SELECT shardlens_ensure_daily_partitions($1::text[], $2::date, $3::date) AS n',
      [tables, from, to],
    );
    created += res.rows[0]?.n ?? 0;
  }
  return created;
}

/** The scheduled job's `ensurePartitions`: throws rather than wait more than `JOB_LOCK_TIMEOUT` for a busy table. */
export function ensurePartitionsPatiently(
  db: Db,
  now: Date,
  retention: { rawDays: number; auditDays: number },
): Promise<number> {
  return transaction(db, async (tx) => {
    await tx.query(`SET LOCAL lock_timeout = '${JOB_LOCK_TIMEOUT}'`);
    return ensurePartitions(tx, now, retention);
  });
}

/**
 * Drops daily partitions older than each table's retention. A partition whose table stays locked for
 * `JOB_LOCK_TIMEOUT` is left for the next run and listed in `busy`.
 */
export async function dropExpiredPartitions(
  db: Db,
  now: Date,
  retention: { rawDays: number; auditDays: number },
): Promise<{ dropped: string[]; busy: string[] }> {
  const dropped: string[] = [];
  const busy: string[] = [];
  for (const table of DAILY_TABLES) {
    const setting = RETENTION_DAYS[table];
    const days = setting === 'raw' ? retention.rawDays : setting === 'audit' ? retention.auditDays : setting;
    const cutoff = day(now.getTime() - days * 86_400_000).replace(/-/g, '');
    const parts = await db.query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_inherits i
         JOIN pg_class c ON c.oid = i.inhrelid
         JOIN pg_class p ON p.oid = i.inhparent
        WHERE p.relname = $1`,
      [table],
    );
    for (const { name } of parts.rows) {
      const suffix = name.slice(table.length + 1);
      if (!/^\d{8}$/.test(suffix) || suffix >= cutoff) continue;
      try {
        await transaction(db, async (tx) => {
          await tx.query(`SET LOCAL lock_timeout = '${JOB_LOCK_TIMEOUT}'`);
          await tx.query(`DROP TABLE IF EXISTS "${name.replace(/"/g, '')}"`);
        });
        dropped.push(name);
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code !== LOCK_NOT_AVAILABLE) throw error;
        busy.push(name);
      }
    }
  }
  return { dropped, busy };
}

/** Partitions known to exist, per database handle: one process can use several databases (embedded mode, tests). */
const knownUniquesPartitions = new WeakMap<Db | Tx, Set<string>>();

/** Creates the `uniques` LIST partition for a salt period if needed. */
export async function ensureUniquesPartition(db: Db | Tx, label: string): Promise<void> {
  const known = knownUniquesPartitions.get(db) ?? new Set<string>();
  if (known.has(label)) return;
  const ident = `uniques_${periodIdent(label)}`;
  // One statement holding a lock for its transaction: two requests creating the same partition at once (every shard
  // asking for its config when a period starts) would otherwise both try, and one would fail.
  await db.query(
    `DO $$ BEGIN
       PERFORM pg_advisory_xact_lock(7241865327);
       CREATE TABLE IF NOT EXISTS "${ident}" PARTITION OF uniques FOR VALUES IN ('${label}');
     END $$`,
  );
  known.add(label);
  knownUniquesPartitions.set(db, known);
}

interface SaltRow {
  period: string;
  secret: Buffer;
}

/** Creates the salt for a period (and its `uniques` partition) if it does not exist yet. */
export async function ensureSalt(db: Db | Tx, appId: string, label: string): Promise<void> {
  const bounds = periodBounds(label);
  if (!bounds) throw new Error('invalid period label');
  await db.query(
    `INSERT INTO salts (app_id, period, secret, period_end, destroy_after)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (app_id, period) DO NOTHING`,
    [appId, label, randomBytes(32), new Date(bounds.end), new Date(bounds.end + SALT_GRACE_MS)],
  );
  await ensureUniquesPartition(db, label);
}

/**
 * How long before a period ends its successor's salt is handed out too. At least 5 minutes: the SDK asks for its
 * settings again 1 to 4 minutes before a salt boundary and counts on finding the next salt in the answer.
 */
export const UPCOMING_SALT_MS = 5 * 60_000;

/**
 * Salts the SDK should hold right now: the current period (created on demand), the previous one while it is still
 * inside its grace window and, in the last `UPCOMING_SALT_MS` of the period, the next one, so a bot whose clock runs
 * slightly ahead already has the salt for the period it thinks has begun. Destroyed salts are never returned. Current
 * period first, the next one last (an SDK that keeps only two drops it).
 */
export async function activeSalts(
  db: Db | Tx,
  appId: string,
  period: SaltPeriod,
  now = new Date(),
): Promise<SaltRow[]> {
  const current = periodLabel(period, now);
  await ensureSalt(db, appId, current);
  const previous = previousPeriodLabel(period, now);
  const wanted = [current, previous];
  const end = periodBounds(current)?.end;
  const upcoming = nextPeriodLabel(period, now);
  if (end !== undefined && end - now.getTime() <= UPCOMING_SALT_MS) {
    await ensureSalt(db, appId, upcoming);
    wanted.push(upcoming);
  }
  const res = await db.query<{ period: string; secret: Buffer }>(
    `SELECT period, secret FROM salts
      WHERE app_id = $1 AND period = ANY($2::text[]) AND secret IS NOT NULL AND destroy_after > $3`,
    [appId, wanted, now],
  );
  const rank = (label: string) => (label === current ? 0 : label === upcoming ? 2 : 1);
  return res.rows.sort((a, b) => rank(a.period) - rank(b.period));
}

/** Labels whose salt is still alive, so ingest can refuse hashes from destroyed or unknown periods. */
export async function livePeriods(db: Db | Tx, appId: string, now = new Date()): Promise<Set<string>> {
  const res = await db.query<{ period: string }>(
    'SELECT period FROM salts WHERE app_id = $1 AND secret IS NOT NULL AND destroy_after > $2',
    [appId, now],
  );
  return new Set(res.rows.map((r) => r.period));
}

/** Creates next period's salt ahead of the boundary, so SDKs never wait at midnight. */
export async function createUpcomingSalts(db: Db, now = new Date()): Promise<void> {
  const apps = await db.query<{ app_id: string; salt_period: SaltPeriod }>('SELECT app_id, salt_period FROM apps');
  for (const app of apps.rows) {
    await ensureSalt(db, app.app_id, periodLabel(app.salt_period, now));
    await ensureSalt(db, app.app_id, nextPeriodLabel(app.salt_period, now));
  }
}

/**
 * Destroys salts past their grace window: final unique counts are written first, then the period's hashed user rows
 * are deleted (or the whole partition dropped once no app needs it) and the secret is set to NULL. After this, old
 * hashes cannot be linked to anyone.
 */
export async function destroyExpiredSalts(
  db: Db,
  now: Date,
  finalise: (appId: string, period: string) => Promise<void>,
): Promise<string[]> {
  const expired = await db.query<{ app_id: string; period: string }>(
    'SELECT app_id, period FROM salts WHERE secret IS NOT NULL AND destroy_after <= $1',
    [now],
  );
  const destroyed: string[] = [];
  for (const { app_id, period } of expired.rows) {
    await finalise(app_id, period);
    await db.query('DELETE FROM uniques WHERE app_id = $1 AND period = $2', [app_id, period]);
    await db.query('UPDATE salts SET secret = NULL, destroyed_at = $3 WHERE app_id = $1 AND period = $2', [
      app_id,
      period,
      now,
    ]);
    const stillLive = await db.query('SELECT 1 FROM salts WHERE period = $1 AND secret IS NOT NULL LIMIT 1', [period]);
    if (stillLive.rowCount === 0) {
      await db.query(`DROP TABLE IF EXISTS "uniques_${periodIdent(period)}"`);
      knownUniquesPartitions.get(db)?.delete(period);
    }
    destroyed.push(`${app_id}:${period}`);
  }
  return destroyed;
}
