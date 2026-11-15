import type { Db } from '../db.js';

const DAY = 86_400_000;
const BUCKET_MS = { rollup_1m: 60_000, rollup_1h: 3_600_000, rollup_1d: DAY } as const;

/**
 * The rollup table to read for a range, and where reading starts. Hourly rollups cover 13 months and anything older
 * comes from daily ones; minute rollups are read only when asked for. A bucket is stored under its start time, so
 * reading starts at the bucket `from` falls in: otherwise "the last hour", asked at 15:20, would return only what
 * happened since 15:00.
 */
export function rollupSource(from: Date, now: Date, minutes = false): { table: keyof typeof BUCKET_MS; from: Date } {
  const table = minutes ? 'rollup_1m' : now.getTime() - from.getTime() <= 395 * DAY ? 'rollup_1h' : 'rollup_1d';
  const size = BUCKET_MS[table];
  return { table, from: new Date(Math.floor(from.getTime() / size) * size) };
}

/**
 * Where reading raw rows starts: they are kept for the app's raw retention (Settings → General, 7 to 90 days), and the
 * answer says from when, so the dashboard can say what it counted.
 */
export async function rawFrom(db: Db, appId: string, from: Date, now: Date): Promise<Date> {
  const app = await db.query<{ days: number }>('SELECT raw_retention_days AS days FROM apps WHERE app_id = $1', [
    appId,
  ]);
  return new Date(Math.max(from.getTime(), now.getTime() - (app.rows[0]?.days ?? 35) * DAY));
}
