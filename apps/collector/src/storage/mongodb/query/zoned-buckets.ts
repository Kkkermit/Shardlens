import type { Document } from 'mongodb';

/*
 * Time zones in a pipeline, as PostgreSQL's queries use them: `ts AT TIME ZONE zone` turns an instant into a wall
 * time (a timestamp without zone), which `date_trunc` and `to_char` then cut and print as a plain clock. Here a wall
 * time is a date whose UTC fields are the zone's clock, so truncating and printing it in UTC never meets a DST change.
 * Zones come from MongoDB's own time zone database (`supportsTimeZone` in `settings.ts` checks Settings against it).
 */

/** `date AT TIME ZONE zone`. */
export function wallClock(date: unknown, zone: string): Document {
  return {
    $let: {
      vars: { p: { $dateToParts: { date, timezone: { $literal: zone } } } },
      in: {
        $dateFromParts: {
          year: '$$p.year',
          month: '$$p.month',
          day: '$$p.day',
          hour: '$$p.hour',
          minute: '$$p.minute',
          second: '$$p.second',
          millisecond: '$$p.millisecond',
        },
      },
    },
  };
}

/** `date_trunc(unit, wall)`. Weeks are ISO weeks, from Monday. */
export function truncWall(wall: unknown, unit: 'minute' | 'hour' | 'day' | 'week' | 'month'): Document {
  return { $dateTrunc: { date: wall, unit, ...(unit === 'week' ? { startOfWeek: 'monday' } : {}) } };
}

/** `to_char(wall, 'YYYY-MM-DD"T"HH24:MI:SS')`. */
export const clockText = (wall: unknown): Document => ({ $dateToString: { date: wall, format: '%Y-%m-%dT%H:%M:%S' } });

/** `to_char(wall, 'YYYY-MM-DD')`. */
export const dayText = (wall: unknown): Document => ({ $dateToString: { date: wall, format: '%Y-%m-%d' } });
