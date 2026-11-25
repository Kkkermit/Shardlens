import type { Collection } from 'mongodb';
import { ACCEPT_BACK_DAYS } from '../../retention.js';
import type { RollupDoc } from '../collections.js';
import type { Mongo } from '../connect.js';

const DAY = 86_400_000;
const BUCKET_MS = { minute: 60_000, hour: 3_600_000, day: DAY } as const;

/**
 * The rollups to read for a range, and where reading starts, as PostgreSQL's `rollupSource`
 * (`postgres/query/rollup-source.ts`) picks them: hourly ones for 13 months, daily ones beyond, minutes only when asked
 * for, read from the start of the bucket `from` falls in.
 */
export function rollupSource(
  m: Mongo,
  from: Date,
  now: Date,
  minutes = false,
): { grain: keyof typeof BUCKET_MS; rollups: Collection<RollupDoc>; from: Date } {
  const grain = minutes ? 'minute' : now.getTime() - from.getTime() <= 395 * DAY ? 'hour' : 'day';
  const size = BUCKET_MS[grain];
  const rollups = grain === 'minute' ? m.c.rollup1m : grain === 'hour' ? m.c.rollup1h : m.c.rollup1d;
  return { grain, rollups, from: new Date(Math.floor(from.getTime() / size) * size) };
}

/** Where reading single events starts: they are kept for the app's raw retention, and the answer says from when. */
export async function rawFrom(m: Mongo, appId: string, from: Date, now: Date): Promise<Date> {
  const app = await m.c.apps.findOne({ _id: appId }, { projection: { rawRetentionDays: 1 } });
  return new Date(Math.max(from.getTime(), now.getTime() - (app?.rawRetentionDays ?? ACCEPT_BACK_DAYS) * DAY));
}
