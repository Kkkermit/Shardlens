/** Pure helpers for charts (no DOM), so they can be unit tested. */

export interface Series {
  name: string;
  values: (number | null)[];
}

const DAY_S = 86_400;
const formats = new Map<string, Intl.DateTimeFormat>();

/**
 * A cached date formatter in the viewer's locale (`locale` is for tests). Always in UTC: x values are wall-clock times
 * in the app's time zone, encoded as UTC seconds.
 */
function dates(options: Intl.DateTimeFormatOptions, locale?: string): Intl.DateTimeFormat {
  const key = `${locale ?? ''}|${JSON.stringify(options)}`;
  let format = formats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' });
    formats.set(key, format);
  }
  return format;
}

const at = (sec: number) => new Date(sec * 1000);

/** An x value as the date, or date and time, it stands for, in the viewer's locale: for tooltips and table views. */
export function formatX(sec: number, withTime: boolean, locale?: string): string {
  return dates(withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' }, locale).format(
    at(sec),
  );
}

/**
 * Tick labels for a time axis in the viewer's locale, for uPlot's `values` (`step` is uPlot's tick increment in
 * seconds). Under a day apart, ticks are times, with the date under the first one and under each midnight; a day or
 * more apart, they are dates, with the year under the first and wherever it changes.
 */
export function timeAxisLabels(splits: readonly number[], step: number, locale?: string): string[] {
  const day = dates({ month: 'short', day: 'numeric' }, locale);
  const year = dates({ year: 'numeric' }, locale);
  const month = dates({ month: 'short' }, locale);
  const time = dates({ timeStyle: 'short' }, locale);
  const dayOf = (sec: number) => Math.floor(sec / DAY_S);
  const yearOf = (sec: number) => at(sec).getUTCFullYear();
  return splits.map((sec, i) => {
    const prev = i > 0 ? splits[i - 1] : undefined;
    if (step < DAY_S) {
      const label = time.format(at(sec));
      return prev === undefined || dayOf(prev) !== dayOf(sec) ? `${label}\n${day.format(at(sec))}` : label;
    }
    const label = step >= 28 * DAY_S ? month.format(at(sec)) : day.format(at(sec));
    return prev === undefined || yearOf(prev) !== yearOf(sec) ? `${label}\n${year.format(at(sec))}` : label;
  });
}

/** Short weekday names in the viewer's locale, Monday first (ISO weekdays 1 to 7). */
export function weekdayNames(locale?: string): string[] {
  const weekday = dates({ weekday: 'short' }, locale);
  // 5 January 1970 was a Monday.
  return Array.from({ length: 7 }, (_, i) => weekday.format(at((4 + i) * DAY_S)));
}

/**
 * The x range for a chart's points. For a single point uPlot adds `86400 / ms` seconds, about 1,000 days with
 * second timestamps, which reads as broken on a new install whose data is all in one bucket: a day either side instead.
 */
export function xRange(xs: ArrayLike<number>, min: number, max: number): [number, number] {
  const only = xs.length === 1 ? xs[0] : undefined;
  return only === undefined ? [min, max] : [only - 86_400, only + 86_400];
}

/** Pivots `{t, key, value}` points into aligned uPlot data. */
export function pivot(
  points: { t: string; key: string | null; value: number | null }[],
  name: (key: string | null) => string,
): { x: number[]; series: Series[] } {
  const xs = [...new Set(points.map((p) => p.t))].sort();
  const index = new Map(xs.map((t, i) => [t, i]));
  const keys = [...new Set(points.map((p) => p.key))];
  const series = keys.map((key) => {
    const values: (number | null)[] = new Array(xs.length).fill(0);
    for (const p of points) if (p.key === key) values[index.get(p.t)!] = p.value;
    return { name: name(key), values };
  });
  return { x: xs.map((t) => Date.parse(`${t}Z`) / 1000), series };
}

/** A `YYYY-MM-DD` day as the x value (Unix seconds, UTC midnight) the time charts expect. */
export const dayX = (day: string) => Date.parse(`${day}T00:00:00Z`) / 1000;
