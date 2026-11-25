import type { Collection } from 'mongodb';
import { ACCEPT_BACK_DAYS } from '../../retention.js';
import type { RollupDoc } from '../collections.js';
import type { Mongo } from '../connect.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MINUTE = 60_000;

/**
 * The rollups to read for a range, and where reading starts, as PostgreSQL's `rollupSource` chooses them: hourly ones
 * cover 13 months and anything older comes from daily ones; minutes only when asked for. Reading starts at the start
 * of the bucket `from` falls in.
 */
export function rollupSource(
  m: Mongo,
  from: Date,
  now: Date,
  minutes = false,
): { rollups: Collection<RollupDoc>; from: Date } {
  const hourly = now.getTime() - from.getTime() <= 395 * DAY;
  const [rollups, size] = minutes ? [m.c.rollup1m, MINUTE] : hourly ? [m.c.rollup1h, HOUR] : [m.c.rollup1d, DAY];
  return { rollups, from: new Date(Math.floor(from.getTime() / size) * size) };
}

/** Where reading single events starts: they are kept for the app's raw retention. */
export async function rawFrom(m: Mongo, appId: string, from: Date, now: Date): Promise<Date> {
  const app = await m.c.apps.findOne({ _id: appId }, { projection: { rawRetentionDays: 1 } });
  return new Date(Math.max(from.getTime(), now.getTime() - (app?.rawRetentionDays ?? ACCEPT_BACK_DAYS) * DAY));
}
