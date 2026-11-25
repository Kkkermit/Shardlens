import type { Db } from '../../db.js';
import { COMMAND_KINDS_SQL } from '../../ingest/codes.js';
import { periodBounds } from '../periods.js';

/**
 * Minute rollups, recomputed from raw rows with upserts so re-running a window never double-counts.
 * Each entry is one metric: a SELECT producing (app_id, bucket, metric, dims, count, sum, min, max, hist) for raw rows
 * in [$1, $2). Every SQL string here is a constant; only the window bounds are parameters.
 */
const MINUTE_SOURCES: readonly string[] = [
  // interactions: commands, context menus, entry points and message commands. No server dimension here, so the table
  // doesn't grow with commands × servers; per-server numbers come from `interactions.by_guild` below.
  `SELECT app_id, date_trunc($3, ts) AS bucket, 'interactions' AS metric,
          jsonb_build_object('kind', kind, 'command', command, 'sub', sub, 'outcome', outcome, 'context', context,
            'install', install, 'locale', locale, 'tier', member_tier) AS dims,
          sum(weight) AS count, sum(coalesce(ack_ms, 0) * weight) AS sum, min(ack_ms) AS min, max(ack_ms) AS max,
          shardlens_hist_sum(shardlens_hist_one(ack_ms, weight)) AS hist
     FROM interactions WHERE ts >= $1 AND ts < $2 AND kind IN ${COMMAND_KINDS_SQL}
    GROUP BY app_id, 2, kind, command, sub, outcome, context, install, locale, member_tier`,
  `SELECT app_id, date_trunc($3, ts), 'interactions.by_guild',
          jsonb_build_object('kind', kind, 'command', command, 'outcome', outcome, 'guild', guild_id::text),
          sum(weight), sum(coalesce(ack_ms, 0) * weight), min(ack_ms), max(ack_ms),
          shardlens_hist_sum(shardlens_hist_one(ack_ms, weight))
     FROM interactions WHERE ts >= $1 AND ts < $2 AND kind IN ${COMMAND_KINDS_SQL} AND guild_id IS NOT NULL
    GROUP BY app_id, 2, kind, command, outcome, guild_id`,
  `SELECT app_id, date_trunc($3, ts), 'interactions.autocomplete',
          jsonb_build_object('command', command, 'option', options[1]),
          sum(weight), sum(coalesce(ack_ms, 0) * weight), min(ack_ms), max(ack_ms),
          shardlens_hist_sum(shardlens_hist_one(ack_ms, weight))
     FROM interactions WHERE ts >= $1 AND ts < $2 AND kind = 8
    GROUP BY app_id, 2, command, options[1]`,
  `SELECT app_id, date_trunc($3, ts), 'components',
          jsonb_build_object('kind', kind, 'custom_id', custom_id, 'source', source_command, 'outcome', outcome,
            'guild', guild_id::text),
          sum(weight), sum(coalesce(ack_ms, 0) * weight), min(ack_ms), max(ack_ms),
          shardlens_hist_sum(shardlens_hist_one(ack_ms, weight))
     FROM interactions WHERE ts >= $1 AND ts < $2 AND kind IN (5, 6)
    GROUP BY app_id, 2, kind, custom_id, source_command, outcome, guild_id`,
  `SELECT app_id, date_trunc($3, ts), 'modals.submitted',
          jsonb_build_object('custom_id', custom_id, 'outcome', outcome),
          sum(weight), sum(coalesce(ack_ms, 0) * weight), min(ack_ms), max(ack_ms),
          shardlens_hist_sum(shardlens_hist_one(ack_ms, weight))
     FROM interactions WHERE ts >= $1 AND ts < $2 AND kind = 7
    GROUP BY app_id, 2, custom_id, outcome`,
  `SELECT app_id, date_trunc($3, ts), 'modals.shown',
          jsonb_build_object('command', coalesce(command, source_command), 'custom_id', custom_id),
          sum(weight), 0, NULL::double precision, NULL::double precision, NULL::integer[]
     FROM interactions WHERE ts >= $1 AND ts < $2 AND response_type = 9
    GROUP BY app_id, 2, coalesce(command, source_command), custom_id`,
  `SELECT app_id, date_trunc($3, ts), 'interactions.errors',
          jsonb_build_object('command', command, 'error_class', error_class),
          sum(weight), sum(coalesce(handler_ms, 0) * weight), min(handler_ms), max(handler_ms), NULL::integer[]
     FROM interaction_errors WHERE ts >= $1 AND ts < $2
    GROUP BY app_id, 2, command, error_class`,
  `SELECT app_id, date_trunc($3, ts), 'rest.calls',
          jsonb_build_object('method', method, 'route', route, 'status', status),
          sum(count * weight), sum(retries * weight), NULL::double precision, NULL::double precision,
          shardlens_hist_sum(hist)
     FROM rest_calls WHERE ts >= $1 AND ts < $2
    GROUP BY app_id, 2, method, route, status`,
  `SELECT app_id, date_trunc($3, ts), 'rest.invalid', jsonb_build_object('status', s.status),
          sum(s.n), 0, NULL::double precision, NULL::double precision, NULL::integer[]
     FROM rest_invalid,
          LATERAL (VALUES ('401', count401), ('403', count403), ('429', count429), ('429_shared', shared429)) AS s(status, n)
    WHERE ts >= $1 AND ts < $2
    GROUP BY app_id, 2, s.status`,
  `SELECT app_id, date_trunc($3, ts), 'rest.ratelimits', jsonb_build_object('scope', scope, 'route', route),
          count(*), sum(retry_after), min(retry_after), max(retry_after), NULL::integer[]
     FROM rate_limits WHERE ts >= $1 AND ts < $2
    GROUP BY app_id, 2, scope, route`,
  `SELECT app_id, date_trunc($3, ts),
          CASE kind WHEN 1 THEN 'guild.joins' WHEN 2 THEN 'guild.leaves' ELSE 'guild.unavailable' END,
          jsonb_build_object('detected', detected_at_startup),
          count(*), 0, NULL::double precision, NULL::double precision, NULL::integer[]
     FROM guild_events WHERE ts >= $1 AND ts < $2 AND kind IN (1, 2, 3)
    GROUP BY app_id, 2, kind, detected_at_startup`,
  `SELECT app_id, date_trunc($3, ts), 'webhook.' || lower(type), jsonb_build_object('integration_type', integration_type),
          count(*), 0, NULL::double precision, NULL::double precision, NULL::integer[]
     FROM webhook_events WHERE ts >= $1 AND ts < $2
    GROUP BY app_id, 2, type, integration_type`,
  `SELECT app_id, date_trunc($3, ts), 'entitlements', jsonb_build_object('action', action, 'sku', sku_id::text, 'source', source),
          count(*), 0, NULL::double precision, NULL::double precision, NULL::integer[]
     FROM entitlements WHERE ts >= $1 AND ts < $2
    GROUP BY app_id, 2, action, sku_id, source`,
  `SELECT app_id, date_trunc($3, ts), 'subscriptions', jsonb_build_object('action', action, 'status', status),
          count(*), 0, NULL::double precision, NULL::double precision, NULL::integer[]
     FROM subscriptions WHERE ts >= $1 AND ts < $2
    GROUP BY app_id, 2, action, status`,
  `SELECT app_id, date_trunc($3, ts), 'custom.' || name, '{}'::jsonb,
          sum(weight), 0, NULL::double precision, NULL::double precision, NULL::integer[]
     FROM custom_events WHERE ts >= $1 AND ts < $2
    GROUP BY app_id, 2, name`,
];

const UPSERT = `ON CONFLICT (app_id, metric, dims_hash, bucket) DO UPDATE
  SET dims = EXCLUDED.dims, count = EXCLUDED.count, sum = EXCLUDED.sum, min = EXCLUDED.min, max = EXCLUDED.max,
      hist = EXCLUDED.hist`;

type Grain = 'minute' | 'hour' | 'day';
const GRAIN_TABLE: Record<Grain, string> = { minute: 'rollup_1m', hour: 'rollup_1h', day: 'rollup_1d' };

/** Statements that failed on their data, as `metric grain from–to`. */
type Skipped = string[];

/**
 * Runs one rollup statement. A row the database can't aggregate (a sum that overflows, say) skips that statement and
 * is reported, instead of stopping every metric after it, for every app, on every run. Other errors (the database is
 * down) still fail the run.
 */
async function isolated(skipped: Skipped | undefined, what: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (!skipped || typeof code !== 'string' || !code.startsWith('22')) throw error;
    skipped.push(what);
  }
}

const span = (from: Date, to: Date) => `${from.toISOString()}–${to.toISOString()}`;

async function rollupFromRaw(db: Db, grain: Grain, from: Date, to: Date, skipped?: Skipped): Promise<void> {
  for (const [i, source] of MINUTE_SOURCES.entries()) {
    await isolated(skipped, `source ${i} by ${grain} ${span(from, to)}`, () =>
      db.query(
        `INSERT INTO ${GRAIN_TABLE[grain]} (app_id, bucket, metric, dims_hash, dims, count, sum, min, max, hist)
         SELECT s.app_id, s.bucket, s.metric, sha256(convert_to(s.dims::text, 'UTF8')), s.dims,
                s.count, s.sum, s.min, s.max, s.hist
           FROM (${source}) AS s(app_id, bucket, metric, dims, count, sum, min, max, hist)
         ${UPSERT}`,
        [from, to, grain],
      ),
    );
  }
}

async function cascade(db: Db, grain: 'hour' | 'day', from: Date, to: Date, skipped?: Skipped): Promise<void> {
  const table = grain === 'hour' ? 'rollup_1h' : 'rollup_1d';
  await isolated(skipped, `minutes into ${grain}s ${span(from, to)}`, () =>
    db.query(
      `INSERT INTO ${table} (app_id, bucket, metric, dims_hash, dims, count, sum, min, max, hist)
       SELECT app_id, date_trunc('${grain}', bucket), metric, dims_hash, (array_agg(dims))[1],
              sum(count), sum(sum), min(min), max(max), shardlens_hist_sum(hist)
         FROM rollup_1m WHERE bucket >= $1 AND bucket < $2
        GROUP BY app_id, date_trunc('${grain}', bucket), metric, dims_hash
       ${UPSERT}`,
      [from, to],
    ),
  );
}

const floorTo = (ms: number, step: number) => Math.floor(ms / step) * step;
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
/** Most late-event history one run recomputes; the rest stays dirty for the next run. */
const MAX_DIRTY_SPAN_MS = 6 * HOUR;
/**
 * Ingest marks an event's minute dirty only when it arrives more than 2 minutes late (`LATE_MS` in ingest/write.ts).
 * Anything newer must be inside the next run's recent window, however long after its arrival that run starts.
 */
const NOT_MARKED_MS = 2 * MINUTE;
/** Every run recomputes at least this much recent history, whether or not anything was marked. */
const RECENT_MS = 5 * MINUTE;
/** A recent window never reaches further back than this; older history relies on dirty marks. */
const MAX_RECENT_MS = HOUR;

function mergeWindows(windows: [number, number][]): [number, number][] {
  const sorted = [...windows].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [from, to] of sorted) {
    const last = out.at(-1);
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else out.push([from, to]);
  }
  return out;
}

/** Minute rollups are kept 14 days; their partitions start at this day boundary. */
const MINUTE_RETENTION_DAYS = 13;

/** The longest raw retention of any app: raw partitions are shared, so they are kept that long. */
export async function rawRetentionDays(db: Db): Promise<number> {
  const res = await db.query<{ days: number | null }>('SELECT max(raw_retention_days) AS days FROM apps');
  return res.rows[0]?.days ?? 35;
}

/**
 * Recomputes rollups for [from, to): minute rows where minute rollups still exist (last 14 days), then each whole
 * hour and day either from those minutes or, for older periods, straight from raw rows while they are retained.
 * Periods older than raw retention are left alone, so a recompute never shrinks a rollup.
 */
export async function backfillRollups(
  db: Db,
  from: Date,
  to: Date,
  now = new Date(),
  rawDays?: number,
  skipped?: Skipped,
): Promise<void> {
  const keepRaw = rawDays ?? (await rawRetentionDays(db));
  const minuteFloor = floorTo(now.getTime(), DAY) - MINUTE_RETENTION_DAYS * DAY;
  const rawFloor = floorTo(now.getTime(), DAY) - (keepRaw - 1) * DAY;
  const start = from.getTime();
  const end = to.getTime();
  if (end > minuteFloor) await rollupFromRaw(db, 'minute', new Date(Math.max(start, minuteFloor)), to, skipped);
  const hourFrom = floorTo(start, HOUR);
  const hourTo = floorTo(end - 1, HOUR) + HOUR;
  if (hourTo > minuteFloor) {
    await cascade(db, 'hour', new Date(Math.max(hourFrom, minuteFloor)), new Date(hourTo), skipped);
  }
  if (hourFrom < minuteFloor && Math.min(hourTo, minuteFloor) > rawFloor) {
    const window = [new Date(Math.max(hourFrom, rawFloor)), new Date(Math.min(hourTo, minuteFloor))] as const;
    await rollupFromRaw(db, 'hour', ...window, skipped);
  }
  const dayFrom = floorTo(start, DAY);
  const dayTo = floorTo(end - 1, DAY) + DAY;
  if (dayTo > minuteFloor) await cascade(db, 'day', new Date(Math.max(dayFrom, minuteFloor)), new Date(dayTo), skipped);
  if (dayFrom < minuteFloor && Math.min(dayTo, minuteFloor) > rawFloor) {
    const window = [new Date(Math.max(dayFrom, rawFloor)), new Date(Math.min(dayTo, minuteFloor))] as const;
    await rollupFromRaw(db, 'day', ...window, skipped);
  }
}

/**
 * The every-minute rollup run: recent minutes plus minutes marked dirty by late events (merged into ranges and capped
 * per run), then the hours and days they belong to, so hourly and daily charts are at most a minute behind.
 *
 * The recent window reaches back to before the previous run started (`since`), less the age at which ingest starts
 * marking events late, so an event that wasn't marked is always inside some run's window, even when runs fall behind.
 * Dirty marks are taken at the start: a late event committed while this run works marks its minute again for the
 * next run, instead of having its mark deleted by this one. Marks of a run that fails are put back.
 */
export async function runRollups(
  db: Db,
  now = new Date(),
  opts: { since?: Date | undefined } = {},
): Promise<{ windows: number; skipped: string[] }> {
  const end = floorTo(now.getTime(), MINUTE) + MINUTE;
  const sinceFrom = opts.since ? floorTo(opts.since.getTime() - NOT_MARKED_MS, MINUTE) : end;
  const recentFrom = Math.max(end - MAX_RECENT_MS, Math.min(end - RECENT_MS, sinceFrom));
  const claimed = await db.query<{ app_id: string; bucket: Date }>(
    `DELETE FROM dirty_buckets WHERE bucket IN (
       SELECT DISTINCT bucket FROM dirty_buckets WHERE bucket < $1 ORDER BY bucket LIMIT $2
     ) RETURNING app_id, bucket`,
    [new Date(recentFrom), MAX_DIRTY_SPAN_MS / MINUTE],
  );
  const late: [number, number][] = claimed.rows.map(({ bucket }) => {
    const start = floorTo(bucket.getTime(), MINUTE);
    return [start, start + MINUTE];
  });
  // Newest first: what the dashboard shows now doesn't wait behind old history.
  const windows = mergeWindows([[recentFrom, end], ...late]).reverse();
  const skipped: string[] = [];
  try {
    const rawDays = await rawRetentionDays(db);
    for (const [from, to] of windows) await backfillRollups(db, new Date(from), new Date(to), now, rawDays, skipped);
  } catch (error) {
    if (claimed.rows.length > 0) {
      await db
        .query(
          `INSERT INTO dirty_buckets (app_id, bucket) SELECT * FROM unnest($1::bigint[], $2::timestamptz[])
           ON CONFLICT DO NOTHING`,
          [claimed.rows.map((r) => r.app_id), claimed.rows.map((r) => r.bucket)],
        )
        .catch(() => undefined);
    }
    throw error;
  }
  return { windows: windows.length, skipped };
}

/**
 * Unique-user counts for every live salt period: daily counts and new users per scope, counts for the ISO weeks that
 * lie wholly inside the period, and the whole-period count. Rows are rewritten each run until the salt is destroyed,
 * when the last run marks them final; a final row is never written again.
 *
 * A week that spans two periods gets no count: the same person has a different hash in each, so the users of the two
 * parts can't be told apart, and writing each part in turn left whichever came last.
 */
export async function runUniques(db: Db, appId?: string, onlyPeriod?: string, final = false): Promise<void> {
  const periods = await db.query<{ app_id: string; period: string }>(
    `SELECT app_id, period FROM salts
      WHERE secret IS NOT NULL AND ($1::bigint IS NULL OR app_id = $1) AND ($2::text IS NULL OR period = $2)`,
    [appId ?? null, onlyPeriod ?? null],
  );
  for (const { app_id, period } of periods.rows) {
    const bounds = periodBounds(period);
    if (!bounds) continue;
    const params = [app_id, period, final];
    // Day grain, with new users (first day seen in the period).
    await db.query(
      `INSERT INTO unique_counts (app_id, grain, start_day, scope, scope_key, users, new_users, final)
       SELECT u.app_id, 'day', u.day, u.scope, u.scope_key, count(*),
              count(*) FILTER (WHERE f.first_day = u.day), $3
         FROM uniques u
         JOIN (SELECT scope, scope_key, user_hash, min(day) AS first_day FROM uniques
                WHERE app_id = $1 AND period = $2 AND scope IN ('global', 'command')
                GROUP BY scope, scope_key, user_hash) f
           ON f.scope = u.scope AND f.scope_key = u.scope_key AND f.user_hash = u.user_hash
        WHERE u.app_id = $1 AND u.period = $2 AND u.scope IN ('global', 'command')
        GROUP BY u.app_id, u.day, u.scope, u.scope_key
       ON CONFLICT (app_id, grain, start_day, scope, scope_key) DO UPDATE
         SET users = EXCLUDED.users, new_users = EXCLUDED.new_users, final = EXCLUDED.final
         WHERE NOT unique_counts.final`,
      params,
    );
    const start = new Date(bounds.start).toISOString().slice(0, 10);
    const end = new Date(bounds.end).toISOString().slice(0, 10);
    // ISO weeks wholly inside the period (global only).
    await db.query(
      `INSERT INTO unique_counts (app_id, grain, start_day, scope, scope_key, users, new_users, final)
       SELECT app_id, 'week', date_trunc('week', day)::date, scope, scope_key, count(DISTINCT user_hash), 0, $3
         FROM uniques WHERE app_id = $1 AND period = $2 AND scope = 'global'
        GROUP BY app_id, date_trunc('week', day), scope, scope_key
       HAVING date_trunc('week', day)::date >= $4::date AND date_trunc('week', day)::date + 7 <= $5::date
       ON CONFLICT (app_id, grain, start_day, scope, scope_key) DO UPDATE
         SET users = EXCLUDED.users, final = EXCLUDED.final
         WHERE NOT unique_counts.final`,
      [...params, start, end],
    );
    // Whole period, every scope (start_day = first day of the period).
    await db.query(
      `INSERT INTO unique_counts (app_id, grain, start_day, scope, scope_key, users, new_users, final)
       SELECT app_id, 'month', $4::date, scope, scope_key, count(DISTINCT user_hash), 0, $3
         FROM uniques WHERE app_id = $1 AND period = $2
        GROUP BY app_id, scope, scope_key
       ON CONFLICT (app_id, grain, start_day, scope, scope_key) DO UPDATE
         SET users = EXCLUDED.users, final = EXCLUDED.final
         WHERE NOT unique_counts.final`,
      [...params, start],
    );
  }
}
