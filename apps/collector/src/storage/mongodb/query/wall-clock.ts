import type { Document } from 'mongodb';
import { wallTime } from '../zoned-time.js';

const DAY = 86_400_000;

/** A stretch of time over which a zone keeps one offset from UTC: from `start` (epoch ms) to the next piece. */
export interface OffsetPiece {
  start: number;
  offset: number;
}

const offsetAt = (zone: string, instant: number) => wallTime(instant, zone) - instant;

/**
 * The zone's offsets over [from, to], as Node's time zone data has them (the data `zoned-time.ts` reads, not the
 * server's): the first piece also covers what comes before `from`, the last what comes after `to`. Changes are looked
 * for a day at a time (no zone changes its offset twice within two days) and then found to the second.
 */
export function offsetPieces(zone: string, from: number, to: number): OffsetPiece[] {
  const pieces: OffsetPiece[] = [{ start: -Infinity, offset: offsetAt(zone, from) }];
  for (let t = from; t < to; t += DAY) {
    const next = Math.min(t + DAY, to);
    const before = pieces.at(-1)!.offset;
    if (offsetAt(zone, next) === before) continue;
    let lo = Math.floor(t / 1000);
    let hi = Math.ceil(next / 1000);
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (offsetAt(zone, mid * 1000) === before) lo = mid;
      else hi = mid;
    }
    pieces.push({ start: hi * 1000, offset: offsetAt(zone, hi * 1000) });
  }
  return pieces;
}

/**
 * `date AT TIME ZONE zone` in a pipeline: the wall clock as a date read in UTC, so `$dateTrunc` and `$dateToString`
 * without a time zone cut and print it as PostgreSQL cuts and prints a `timestamp`. `pieces` must cover the dates.
 */
export function wallClock(date: unknown, pieces: readonly OffsetPiece[]): Document {
  let offset: unknown = pieces[0]?.offset ?? 0;
  for (const piece of pieces.slice(1))
    offset = { $cond: [{ $lt: [date, new Date(piece.start)] }, offset, piece.offset] };
  return { $add: [date, offset] };
}

/** `to_char(date_trunc('day', date AT TIME ZONE zone), 'YYYY-MM-DD')` in a pipeline. */
export function localDay(date: unknown, pieces: readonly OffsetPiece[]): Document {
  return { $dateToString: { date: wallClock(date, pieces), format: '%Y-%m-%d' } };
}

/** `to_char(date, 'YYYY-MM-DD')` in UTC, PostgreSQL's session time zone for the collector. */
export function utcDay(date: unknown): Document {
  return { $dateToString: { date, format: '%Y-%m-%d' } };
}
