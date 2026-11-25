import { type Db, type Tx, transaction } from '../../db.js';
import { periodIdent } from '../periods.js';
import { ACCEPT_BACK_DAYS, RETENTION_DAYS } from '../retention.js';

/** Raw tables partitioned by day. */
const DAILY_TABLES = Object.keys(RETENTION_DAYS) as (keyof typeof RETENTION_DAYS)[];

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

/** Drops a salt period's `uniques` partition, once no app has a live salt for that period. */
export async function dropUniquesPartition(db: Db, label: string): Promise<void> {
  await db.query(`DROP TABLE IF EXISTS "uniques_${periodIdent(label)}"`);
  knownUniquesPartitions.get(db)?.delete(label);
}
