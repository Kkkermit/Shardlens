import { periodBounds, periodLabel, type SaltPeriod } from '../../periods.js';
import type { Mongo } from '../connect.js';

/** The first day of the salt period `now` is in, `YYYY-MM-DD`: what unique users of "this period" count from. */
export function periodStartOf(period: SaltPeriod | undefined, now: Date): string {
  const bounds = periodBounds(periodLabel(period ?? 'month', now));
  return new Date(bounds?.start ?? now.getTime()).toISOString().slice(0, 10);
}

/** {@link periodStartOf} the app's salt period (monthly for an app not registered). */
export async function currentPeriodStart(m: Mongo, appId: string, now: Date): Promise<string> {
  const app = await m.c.apps.findOne({ _id: appId }, { projection: { saltPeriod: 1 } });
  return periodStartOf(app?.saltPeriod, now);
}
