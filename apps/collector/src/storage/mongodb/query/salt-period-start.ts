import { periodBounds, periodLabel } from '../../periods.js';
import type { Mongo } from '../connect.js';

/** First day (`YYYY-MM-DD`, UTC) of the app's salt period at `now`, which this period's unique users count from. */
export async function saltPeriodStart(m: Mongo, appId: string, now: Date): Promise<string> {
  const app = await m.c.apps.findOne({ _id: appId }, { projection: { saltPeriod: 1 } });
  const bounds = periodBounds(periodLabel(app?.saltPeriod ?? 'month', now));
  return new Date(bounds?.start ?? now.getTime()).toISOString().slice(0, 10);
}
