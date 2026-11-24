import { randomBytes } from 'node:crypto';
import {
  nextPeriodLabel,
  periodBounds,
  periodLabel,
  previousPeriodLabel,
  SALT_GRACE_MS,
  type SaltPeriod,
} from './periods.js';
import type { Store } from './store.js';

/** Creates the salt for a period if it does not exist yet. */
export async function ensureSalt(store: Store, appId: string, label: string): Promise<void> {
  const bounds = periodBounds(label);
  if (!bounds) throw new Error('invalid period label');
  await store.salts.ensure(appId, {
    period: label,
    secret: randomBytes(32),
    periodEnd: new Date(bounds.end),
    destroyAfter: new Date(bounds.end + SALT_GRACE_MS),
  });
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
  store: Store,
  appId: string,
  period: SaltPeriod,
  now = new Date(),
): Promise<{ period: string; secret: Buffer }[]> {
  const current = periodLabel(period, now);
  await ensureSalt(store, appId, current);
  const previous = previousPeriodLabel(period, now);
  const wanted = [current, previous];
  const end = periodBounds(current)?.end;
  const upcoming = nextPeriodLabel(period, now);
  if (end !== undefined && end - now.getTime() <= UPCOMING_SALT_MS) {
    await ensureSalt(store, appId, upcoming);
    wanted.push(upcoming);
  }
  const rank = (label: string) => (label === current ? 0 : label === upcoming ? 2 : 1);
  return (await store.salts.alive(appId, wanted, now)).sort((a, b) => rank(a.period) - rank(b.period));
}

/** Creates next period's salt ahead of the boundary, so SDKs never wait at midnight. */
export async function createUpcomingSalts(store: Store, now = new Date()): Promise<void> {
  for (const app of await store.apps.list()) {
    await ensureSalt(store, app.appId, periodLabel(app.saltPeriod, now));
    await ensureSalt(store, app.appId, nextPeriodLabel(app.saltPeriod, now));
  }
}

/**
 * Destroys salts past their grace window: final unique counts are written first (`finalise`), then the period's hashed
 * user rows are deleted and the secret removed. After this, old hashes cannot be linked to anyone.
 */
export async function destroyExpiredSalts(
  store: Store,
  now: Date,
  finalise: (appId: string, period: string) => Promise<void>,
): Promise<string[]> {
  const destroyed: string[] = [];
  for (const { appId, period } of await store.salts.expired(now)) {
    await finalise(appId, period);
    await store.salts.destroy(appId, period, now);
    destroyed.push(`${appId}:${period}`);
  }
  return destroyed;
}
