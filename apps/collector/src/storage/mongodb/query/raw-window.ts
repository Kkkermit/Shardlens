import { ACCEPT_BACK_DAYS } from '../../retention.js';
import type { Mongo } from '../connect.js';

const DAY = 86_400_000;

/**
 * Where reading single events starts: they are kept for the app's raw retention (7 to 90 days), and the answer says
 * from when, as PostgreSQL's `rawFrom` (`postgres/query/rollup-source.ts`) does.
 */
export async function rawFrom(m: Mongo, appId: string, from: Date, now: Date): Promise<Date> {
  const app = await m.c.apps.findOne({ _id: appId }, { projection: { rawRetentionDays: 1 } });
  return new Date(Math.max(from.getTime(), now.getTime() - (app?.rawRetentionDays ?? ACCEPT_BACK_DAYS) * DAY));
}
