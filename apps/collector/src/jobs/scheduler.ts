import { createUpcomingSalts, destroyExpiredSalts } from '../storage/salts.js';
import type { Store } from '../storage/store.js';
import { runAlerts } from './alerts.js';
import { runReports } from './reports.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

interface JobLogger {
  info(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface Jobs {
  stop(): Promise<void>;
}

export async function runSalts(store: Store, now: Date): Promise<string[]> {
  await createUpcomingSalts(store, now);
  return destroyExpiredSalts(store, now, (appId, period) => store.jobs.runUniques(appId, period, true));
}

/**
 * Background jobs, run only by the collector that leads (`JobStorage.leader`). If the leader dies, another collector
 * takes over within 30 seconds.
 */
export function startJobs(
  store: Store,
  log: JobLogger,
  opts?: { settingsKey: string; dashboardUrl: URL | undefined },
): Jobs {
  const contender = store.jobs.leader();
  let leader = false;
  let stopped = false;
  let running: Promise<void> = Promise.resolve();
  const timers: ReturnType<typeof setInterval>[] = [];
  const lastRun = new Map<string, number>();
  /** Jobs queued or running. A tick skips them, so a run that takes longer than a minute never builds a backlog. */
  const pending = new Set<string>();
  let lastRollups: Date | undefined;

  const serial = (name: string, fn: () => Promise<unknown>) => {
    if (pending.has(name)) return running;
    pending.add(name);
    // Stamped when queued. Stamped when finished, a job due every 5 minutes runs every 6: at the fifth tick it is
    // still a few seconds short.
    lastRun.set(name, Date.now());
    running = running.then(async () => {
      try {
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
      } finally {
        pending.delete(name);
      }
    });
    return running;
  };

  const rollups = async () => {
    const started = new Date(store.now());
    const { skipped } = await store.jobs.runRollups(started, { since: lastRollups });
    lastRollups = started;
    if (skipped.length > 0)
      log.error({ job: 'rollups', skipped }, 'rows the database could not aggregate were skipped');
  };

  // Due within half a tick counts as due. A tick can come a moment before the interval is up (the election queues
  // the first runs between two ticks, and timers round differently from the clock), and the job would then wait
  // for the next one: a 5-minute job every 6 minutes.
  const due = (name: string, every: number) => Date.now() - (lastRun.get(name) ?? 0) >= every - MINUTE / 2;

  const tick = () => {
    if (!leader) return;
    void serial('rollups', rollups);
    if (opts) void serial('alerts', () => runAlerts(store, opts));
    if (opts && due('reports', 5 * MINUTE)) void serial('reports', () => runReports(store, opts));
    if (due('uniques', 5 * MINUTE)) void serial('uniques', () => store.jobs.runUniques());
    if (due('partitions', HOUR)) void serial('partitions', () => store.jobs.ensurePartitions(new Date()));
    if (due('salts', HOUR)) void serial('salts', () => runSalts(store, new Date()));
    if (due('retention', 24 * HOUR)) void serial('retention', () => store.jobs.runRetention(new Date()));
  };

  let electing: Promise<void> | undefined;
  const elect = async () => {
    if (stopped || leader) return;
    try {
      const won = await contender.tryLead(() => {
        leader = false;
      });
      if (won && !stopped) {
        leader = true;
        log.info({}, 'this collector is now the job leader');
        tick();
      }
    } catch (error) {
      log.error({ err: error }, 'leader election failed');
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
      await contender.release();
    },
  };
}
