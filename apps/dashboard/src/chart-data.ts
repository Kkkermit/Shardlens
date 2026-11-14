/** Pure helpers for charts (no DOM), so they can be unit tested. */

export interface Series {
  name: string;
  values: (number | null)[];
}

const pad2 = (n: number) => String(n).padStart(2, '0');
/** x values are wall-clock times in the app's time zone, encoded as UTC seconds. */
export function formatX(sec: number, withTime: boolean): string {
  const d = new Date(sec * 1000);
  const day = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  return withTime ? `${day} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}` : day;
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
