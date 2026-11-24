import type { Db } from '../../db.js';
import type { JobStorage } from '../store.js';
import { postgresLeader } from './leader.js';
import { dropExpiredPartitions, ensurePartitionsPatiently } from './partitions.js';
import { backfillRollups, rawRetentionDays, runRollups, runUniques } from './rollups.js';

async function retentionSettings(db: Db): Promise<{ rawDays: number; auditDays: number }> {
  const audit = await db.query<{ days: number | null }>(
    "SELECT max((value #>> '{}')::int) AS days FROM settings WHERE key = 'audit_retention_days'",
  );
  return {
    rawDays: await rawRetentionDays(db),
    auditDays: Math.min(90, Math.max(1, audit.rows[0]?.days ?? 30)),
  };
}

async function runRetention(db: Db, now: Date): Promise<void> {
  await db.query("DELETE FROM rollup_1h WHERE bucket < $1::timestamptz - interval '13 months'", [now]);
  await db.query("DELETE FROM guilds WHERE left_at < $1::timestamptz - interval '90 days'", [now]);
  await db.query('DELETE FROM sessions WHERE expires_at < $1', [now]);
  await db.query("DELETE FROM audit_access_log WHERE ts < $1::timestamptz - interval '1 year'", [now]);
  await db.query("DELETE FROM admin_audit WHERE ts < $1::timestamptz - interval '1 year'", [now]);
  await db.query("DELETE FROM snapshot_pending WHERE ts < $1::timestamptz - interval '1 day'", [now]);
  // One row per bot process, and a restarted process is a new one.
  await db.query("DELETE FROM sdk_health WHERE ts < $1::timestamptz - interval '30 days'", [now]);
  // Last, and failing the job when a partition was busy, so it runs again in a minute rather than tomorrow.
  const { busy } = await dropExpiredPartitions(db, now, await retentionSettings(db));
  if (busy.length > 0) throw new Error(`partitions in use, dropped on a later run: ${busy.join(', ')}`);
}

export function postgresJobs(db: Db): JobStorage {
  return {
    leader: () => postgresLeader(db),
    runRollups: (now, opts) => runRollups(db, now, opts),
    backfillRollups: (from, to, now) => backfillRollups(db, from, to, now),
    runUniques: (appId, period, final) => runUniques(db, appId, period, final),
    async ensurePartitions(now) {
      await ensurePartitionsPatiently(db, now, await retentionSettings(db));
    },
    runRetention: (now) => runRetention(db, now),
  };
}
