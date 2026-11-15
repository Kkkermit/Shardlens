import type { Db } from '../db.js';
import { COMMAND_KINDS_SQL } from '../ingest/codes.js';
import type { QuerySpec } from './spec.js';

type Spec<K extends QuerySpec['kind']> = Extract<QuerySpec, { kind: K }>;
type Step = Spec<'funnel'>['steps'][number];

/**
 * Funnels, retention cohorts and custom-event breakdowns. They read raw rows, linking a person's steps by their salted
 * hash inside the database; only counts ever leave it. A hash changes with the salt period, so a journey that crosses
 * a period boundary counts as two people. SQL is assembled from constant fragments; every value is a bound parameter.
 */

/** Rows `(u, ts)` for one step, between `$from` and `$to` (parameter positions given). */
function stepSource(step: Step | 'any', params: unknown[], from: string, to: string): string {
  if (step === 'any') {
    return `SELECT user_hash AS u, ts FROM interactions WHERE app_id = $1 AND ts >= ${from} AND ts < ${to}
            UNION ALL
            SELECT user_hash, ts FROM custom_events
             WHERE app_id = $1 AND user_hash IS NOT NULL AND ts >= ${from} AND ts < ${to}`;
  }
  params.push(step.name);
  const name = `$${params.length}`;
  if (step.type === 'event') {
    return `SELECT user_hash AS u, ts FROM custom_events
             WHERE app_id = $1 AND name = ${name} AND user_hash IS NOT NULL AND ts >= ${from} AND ts < ${to}`;
  }
  return `SELECT user_hash AS u, ts FROM interactions
           WHERE app_id = $1 AND command = ${name} AND kind IN ${COMMAND_KINDS_SQL} AND ts >= ${from} AND ts < ${to}`;
}

// The bare name: a command may be a prefix command, which the dashboard writes without a slash.
const label = (step: Step) => step.name;

/**
 * Conversion through 2–5 steps (custom events or commands), each within `windowHours` of entering the funnel, in
 * order. People enter with their first step-1 in the range. Also returns per-day cohorts by entry day and the median
 * time from entry to each later step.
 */
export async function funnel(db: Db, appId: string, spec: Spec<'funnel'>) {
  const from = new Date(spec.range.from);
  const to = new Date(spec.range.to);
  const windowMs = spec.windowHours * 3_600_000;
  const params: unknown[] = [
    appId,
    from,
    to,
    new Date(to.getTime() + windowMs),
    `${spec.windowHours} hours`,
    spec.timezone,
  ];
  const ctes: string[] = [];
  spec.steps.forEach((step, i) => {
    const n = i + 1;
    // Step 1 must happen inside the range; later steps may happen up to the window after it ends.
    ctes.push(`s${n} AS (${stepSource(step, params, '$2', n === 1 ? '$3' : '$4')})`);
    if (n === 1) ctes.push('f1 AS (SELECT u, min(ts) AS t1, min(ts) AS t FROM s1 GROUP BY u)');
    else {
      ctes.push(`f${n} AS (
        SELECT p.u, p.t1, min(s.ts) AS t FROM f${n - 1} p
          JOIN s${n} s ON s.u = p.u AND s.ts > p.t AND s.ts <= p.t1 + $5::interval
         GROUP BY p.u, p.t1)`);
    }
  });
  const steps = spec.steps.map((_, i) => i + 1);
  const joins = steps
    .slice(1)
    .map((n) => `LEFT JOIN f${n} ON f${n}.u = f1.u`)
    .join(' ');
  const counts = steps.map((n) => `count(f${n}.u)::int AS s${n}`).join(', ');
  const medians = steps
    .slice(1)
    .map((n) => `percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM f${n}.t - f1.t1))::float8 AS m${n}`)
    .join(', ');
  const res = await db.query<Record<string, number | string | null>>(
    `WITH ${ctes.join(',\n')}
     SELECT to_char(date_trunc('day', f1.t1 AT TIME ZONE $6), 'YYYY-MM-DD') AS day, ${counts}, ${medians}
       FROM f1 ${joins}
      GROUP BY GROUPING SETS ((date_trunc('day', f1.t1 AT TIME ZONE $6)), ())
      ORDER BY 1 NULLS LAST`,
    params,
  );
  const total = res.rows.find((r) => r.day === null);
  const days = res.rows.filter((r) => r.day !== null);
  return {
    windowHours: spec.windowHours,
    timezone: spec.timezone,
    steps: spec.steps.map((step, i) => ({
      label: label(step),
      type: step.type,
      name: step.name,
      users: Number(total?.[`s${i + 1}`] ?? 0),
      medianSeconds: i === 0 ? null : ((total?.[`m${i + 1}`] as number | null | undefined) ?? null),
    })),
    cohorts: days.map((r) => ({ day: r.day as string, users: steps.map((n) => Number(r[`s${n}`] ?? 0)) })),
  };
}

/**
 * The cohort builder: people who did `start` in the range, grouped by the day or week they first did it, and how many
 * of each cohort did `return` (or anything at all) 1, 2, … periods later.
 */
export async function retention(db: Db, appId: string, spec: Spec<'retention'>) {
  const from = new Date(spec.range.from);
  const to = new Date(spec.range.to);
  const periods = spec.interval === 'day' ? 14 : 8;
  const periodMs = (spec.interval === 'day' ? 1 : 7) * 86_400_000;
  const params: unknown[] = [
    appId,
    from,
    to,
    new Date(to.getTime() + periods * periodMs),
    spec.interval,
    spec.timezone,
  ];
  const start = stepSource(spec.start, params, '$2', '$3');
  const back = stepSource(spec.return, params, '$2', '$4');
  const res = await db.query<{ cohort: string; period: number; users: number }>(
    `WITH st AS (${start}),
          c AS (SELECT u, min(ts) AS t0, date_trunc($5, min(ts) AT TIME ZONE $6) AS cohort FROM st GROUP BY u),
          r AS (${back})
     SELECT to_char(c.cohort, 'YYYY-MM-DD') AS cohort, 0 AS period, count(*)::int AS users FROM c GROUP BY c.cohort
     UNION ALL
     SELECT cohort, period, count(DISTINCT u)::int FROM (
       SELECT to_char(c.cohort, 'YYYY-MM-DD') AS cohort, c.u,
              floor(extract(epoch FROM ((r.ts AT TIME ZONE $6) - c.cohort)) / ${periodMs / 1000})::int AS period
         FROM c JOIN r ON r.u = c.u AND r.ts > c.t0
     ) x WHERE period BETWEEN 1 AND ${periods}
      GROUP BY cohort, period
      ORDER BY 1, 2`,
    params,
  );
  const cohorts = new Map<string, { cohort: string; size: number; retained: number[] }>();
  for (const row of res.rows) {
    const entry = cohorts.get(row.cohort) ?? { cohort: row.cohort, size: 0, retained: new Array(periods).fill(0) };
    if (row.period === 0) entry.size = row.users;
    else if (row.period >= 1 && row.period <= periods) entry.retained[row.period - 1] = row.users;
    cohorts.set(row.cohort, entry);
  }
  return {
    interval: spec.interval,
    timezone: spec.timezone,
    start: spec.start.type === 'command' ? `/${spec.start.name}` : spec.start.name,
    return: spec.return === 'any' ? 'any activity' : label(spec.return),
    periods,
    cohorts: [...cohorts.values()].filter((c) => c.size > 0),
  };
}

/** Custom events in the range: count, distinct people, last seen. */
export async function events(db: Db, appId: string, spec: Spec<'events'>) {
  const res = await db.query(
    `SELECT name, sum(weight)::float8 AS count, count(DISTINCT user_hash)::int AS users, max(ts) AS "lastSeen"
       FROM custom_events WHERE app_id = $1 AND ts >= $2 AND ts < $3
      GROUP BY name ORDER BY 2 DESC, 1 LIMIT 200`,
    [appId, new Date(spec.range.from), new Date(spec.range.to)],
  );
  return { rows: res.rows };
}

/** One custom event's property keys, or the top values of one property. Values are shown as text by the dashboard. */
export async function eventProps(db: Db, appId: string, spec: Spec<'eventProps'>) {
  const params: unknown[] = [appId, new Date(spec.range.from), new Date(spec.range.to), spec.name];
  if (!spec.prop) {
    const res = await db.query(
      `SELECT k AS key, sum(weight)::float8 AS count
         FROM custom_events, jsonb_object_keys(props) AS k
        WHERE app_id = $1 AND ts >= $2 AND ts < $3 AND name = $4
        GROUP BY k ORDER BY 2 DESC, 1 LIMIT 50`,
      params,
    );
    return { name: spec.name, keys: res.rows };
  }
  params.push(spec.prop);
  const res = await db.query(
    `SELECT coalesce(props->>$5, 'null') AS value, sum(weight)::float8 AS count
       FROM custom_events
      WHERE app_id = $1 AND ts >= $2 AND ts < $3 AND name = $4 AND props ? $5
      GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 50`,
    params,
  );
  return { name: spec.name, prop: spec.prop, values: res.rows };
}
