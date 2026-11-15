import type pg from 'pg';
import type { Db } from '../db.js';
import {
  createUpcomingSalts,
  destroyExpiredSalts,
  dropExpiredPartitions,
  ensurePartitions,
} from '../storage/maintenance.js';
import { runAlerts } from './alerts.js';
import { runReports } from './reports.js';
import { rawRetentionDays, runRollups, runUniques } from './rollups.js';

/** Advisory lock key for the single job leader (any constant; shared by every collector). */
const LEADER_LOCK = 727_274_001;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

interface JobLogger {
  info(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface Jobs {
  stop(): Promise<void>;
}

async function retentionSettings(db: Db): Promise<{ rawDays: number; auditDays: number }> {
  const audit = await db.query<{ days: number | null }>(
    "SELECT max((value #>> '{}')::int) AS days FROM settings WHERE key = 'audit_retention_days'",
  );
  return {
    rawDays: await rawRetentionDays(db),
    auditDays: Math.min(90, Math.max(1, audit.rows[0]?.days ?? 30)),
  };
}

export async function runRetention(db: Db, now: Date): Promise<void> {
  await dropExpiredPartitions(db, now, await retentionSettings(db));
  await db.query("DELETE FROM rollup_1h WHERE bucket < $1::timestamptz - interval '13 months'", [now]);
  await db.query("DELETE FROM guilds WHERE left_at < $1::timestamptz - interval '90 days'", [now]);
  await db.query('DELETE FROM sessions WHERE expires_at < $1', [now]);
  await db.query("DELETE FROM audit_access_log WHERE ts < $1::timestamptz - interval '1 year'", [now]);
  await db.query("DELETE FROM admin_audit WHERE ts < $1::timestamptz - interval '1 year'", [now]);
  await db.query("DELETE FROM snapshot_pending WHERE ts < $1::timestamptz - interval '1 day'", [now]);
  // One row per bot process, and a restarted process is a new one.
  await db.query("DELETE FROM sdk_health WHERE ts < $1::timestamptz - interval '30 days'", [now]);
}

export async function runSalts(db: Db, now: Date): Promise<string[]> {
  await createUpcomingSalts(db, now);
  return destroyExpiredSalts(db, now, (appId, period) => runUniques(db, appId, period, true));
}

/**
 * Background jobs, run only by the collector holding the Postgres advisory lock. If the leader dies, its
 * session ends, the lock is released and another collector takes over within 30 seconds.
 */
export function startJobs(db: Db, log: JobLogger, opts?: { settingsKey: string; publicUrl: URL }): Jobs {
  let lockClient: pg.PoolClient | undefined;
  let leader = false;
  let stopped = false;
  let running: Promise<void> = Promise.resolve();
  const timers: ReturnType<typeof setInterval>[] = [];
  const lastRun = new Map<string, number>();

  const serial = (name: string, fn: () => Promise<unknown>) => {
    // Stamped when queued. Stamped when finished, a job due every 5 minutes runs every 6: at the fifth tick it is
    // still a few seconds short.
    lastRun.set(name, Date.now());
    running = running.then(async () => {
      if (stopped || !leader) return;
      const started = Date.now();
      try {
        await fn();
      } catch (error) {
        // Not stamped, so the next tick tries again.
        lastRun.delete(name);
        log.error({ job: name, err: error }, 'job failed');
      } finally {
        const ms = Date.now() - started;
        if (ms > 10_000) log.info({ job: name, ms }, 'slow job');
      }
    });
    return running;
  };

  const due = (name: string, every: number) => Date.now() - (lastRun.get(name) ?? 0) >= every;

  const tick = () => {
    if (!leader) return;
    void serial('rollups', () => runRollups(db));
    if (opts) void serial('alerts', () => runAlerts(db, opts));
    if (opts && due('reports', 5 * MINUTE)) void serial('reports', () => runReports(db, opts));
    if (due('uniques', 5 * MINUTE)) void serial('uniques', () => runUniques(db));
    if (due('partitions', HOUR)) {
      void serial('partitions', async () => ensurePartitions(db, new Date(), await retentionSettings(db)));
    }
    if (due('salts', HOUR)) void serial('salts', () => runSalts(db, new Date()));
    if (due('retention', 24 * HOUR)) void serial('retention', () => runRetention(db, new Date()));
  };

  const dropLock = (client: pg.PoolClient) => {
    if (lockClient !== client) return;
    lockClient = undefined;
    leader = false;
    client.release(true);
  };

  let electing: Promise<void> | undefined;
  const elect = async () => {
    if (stopped || leader) return;
    try {
      if (!lockClient) {
        const client = await db.connect();
        if (stopped) {
          client.release();
          return;
        }
        // The lock lives and dies with this connection's session.
        client.on('error', () => dropLock(client));
        lockClient = client;
      }
      const res = await lockClient.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [LEADER_LOCK]);
      if (res.rows[0]?.ok && !stopped) {
        leader = true;
        log.info({}, 'this collector is now the job leader');
        tick();
      }
    } catch (error) {
      log.error({ err: error }, 'leader election failed');
      if (lockClient) dropLock(lockClient);
    }
  };
  // One attempt at a time: while the database is unreachable, a connection attempt can outlast the 30-second timer.
  const tryLead = () => {
    electing ??= elect().finally(() => {
      electing = undefined;
    });
    return electing;
  };

  timers.push(setInterval(() => void tryLead(), 30_000));
  timers.push(setInterval(tick, MINUTE));
  for (const t of timers) t.unref();
  void tryLead();

  return {
    async stop() {
      stopped = true;
      for (const t of timers) clearInterval(t);
      await running.catch(() => undefined);
      const client = lockClient;
      if (client) {
        await client.query('SELECT pg_advisory_unlock($1)', [LEADER_LOCK]).catch(() => undefined);
        if (lockClient === client) {
          lockClient = undefined;
          client.release();
        }
      }
    },
  };
}
