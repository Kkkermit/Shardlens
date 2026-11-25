/*
 * Wall-clock time in an IANA zone, worked out with `Intl` the way PostgreSQL works it out: `instant AT TIME ZONE zone`
 * gives the wall clock, and `wall AT TIME ZONE zone` gives the instant back, resolving a wall time that a DST change
 * skips or repeats as PostgreSQL does. Wall times are milliseconds since 1970-01-01T00:00 read as if UTC.
 */

const DAY = 86_400_000;

const formats = new Map<string, Intl.DateTimeFormat>();

function format(zone: string): Intl.DateTimeFormat {
  let f = formats.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      era: 'short',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    if (formats.size < 1_000) formats.set(zone, f);
  }
  return f;
}

/** The zone's offset from UTC at `instant`, in milliseconds (whole seconds: zones have never used less). */
function offsetAt(zone: string, instant: number): number {
  const second = Math.floor(instant / 1000) * 1000;
  const part: Record<string, string> = {};
  for (const p of format(zone).formatToParts(second)) part[p.type] = p.value;
  const year = Number(part.year);
  const wall = new Date(0);
  wall.setUTCFullYear(part.era === 'BC' ? 1 - year : year, Number(part.month) - 1, Number(part.day));
  wall.setUTCHours(Number(part.hour), Number(part.minute), Number(part.second));
  return wall.getTime() - second;
}

/** The wall clock in `zone` at `instant`: PostgreSQL's `timestamptz AT TIME ZONE zone`. */
export function wallTime(instant: number, zone: string): number {
  return instant + offsetAt(zone, instant);
}

/**
 * The instant a wall time in `zone` names: PostgreSQL's `timestamp AT TIME ZONE zone` (`DetermineTimeZoneOffset`). It
 * takes the offset a day before and the next change of offset after that. A wall time a change skips (spring forward)
 * is read with the offset before it, one a change repeats (fall back) as the later of the two instants.
 */
export function instantOf(wall: number, zone: string): number {
  const before = offsetAt(zone, wall - DAY);
  if (offsetAt(zone, wall + DAY) === before) return wall - before;
  // The change between: the first second whose offset differs. Changes are at least two days apart in every zone.
  let lo = Math.floor((wall - DAY) / 1000);
  let hi = Math.ceil((wall + DAY) / 1000);
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (offsetAt(zone, mid * 1000) === before) lo = mid;
    else hi = mid;
  }
  const boundary = hi * 1000;
  const beforeTime = wall - before;
  const afterTime = wall - offsetAt(zone, boundary);
  if (beforeTime < boundary && afterTime < boundary) return beforeTime;
  if (beforeTime > boundary && afterTime >= boundary) return afterTime;
  return Math.max(beforeTime, afterTime);
}

/** Midnight starting the wall-clock day `wall` is in (`date_trunc('day', wall)`). */
export function startOfDay(wall: number): number {
  return Math.floor(wall / DAY) * DAY;
}
