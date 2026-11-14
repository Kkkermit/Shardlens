import type { Db } from '../db.js';
import { rollupSource } from './rollup-source.js';

const DAY = 86_400_000;
const rawFrom = (from: Date, now: Date) => new Date(Math.max(from.getTime(), now.getTime() - 35 * DAY));

/** Reliability page: deadlines, errors, REST, rate limits, budgets, shards, process and SDK health. */
export async function reliability(db: Db, appId: string, range: { from: string; to: string }, now: Date) {
  const from = new Date(range.from);
  const to = new Date(range.to);
  const rf = rawFrom(from, now);
  const rollups = rollupSource(from, now);
  const [totals, codes, routes, limits, budget, info, shards, events, process, sdks] = await Promise.all([
    db.query(
      `SELECT sum(weight)::float8 AS runs,
              sum(weight) FILTER (WHERE outcome IN (2, 3))::float8 AS "missedDeadlines",
              sum(weight) FILTER (WHERE outcome = 3)::float8 AS "noResponse",
              sum(weight) FILTER (WHERE outcome = 1)::float8 AS errors,
              (sum(weight) FILTER (WHERE ack_ms > 3000) / nullif(sum(weight) FILTER (WHERE ack_ms IS NOT NULL), 0))::float8 AS "over3sRate",
              shardlens_hist_quantile(shardlens_hist_sum(shardlens_hist_one(ack_ms, weight)), 0.5)::float8 AS "p50Ms",
              shardlens_hist_quantile(shardlens_hist_sum(shardlens_hist_one(ack_ms, weight)), 0.95)::float8 AS "p95Ms",
              shardlens_hist_quantile(shardlens_hist_sum(shardlens_hist_one(ack_ms, weight)), 0.99)::float8 AS "p99Ms"
         FROM interactions WHERE app_id = $1 AND ts >= $2 AND ts < $3`,
      [appId, rf, to],
    ),
    db.query(
      `SELECT coalesce(error_code::text, error_class, 'unknown') AS key, sum(weight)::float8 AS value
         FROM interactions WHERE app_id = $1 AND ts >= $2 AND ts < $3 AND outcome IN (1, 2)
        GROUP BY 1 ORDER BY 2 DESC LIMIT 10`,
      [appId, rf, to],
    ),
    db.query(
      `SELECT dims->>'method' AS method, dims->>'route' AS route, sum(count)::float8 AS calls,
              sum(count) FILTER (WHERE (dims->>'status')::int >= 400)::float8 AS failures,
              sum(sum)::float8 AS retries,
              shardlens_hist_quantile(shardlens_hist_sum(hist), 0.95)::float8 AS "p95Ms"
         FROM ${rollups.table} WHERE app_id = $1 AND metric = 'rest.calls' AND bucket >= $2 AND bucket < $3
        GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 50`,
      [appId, rollups.from, to],
    ),
    db.query(
      `SELECT dims->>'scope' AS scope, dims->>'route' AS route, sum(count)::float8 AS count, max(max)::float8 AS "maxRetryAfter"
         FROM ${rollups.table} WHERE app_id = $1 AND metric = 'rest.ratelimits' AND bucket >= $2 AND bucket < $3
        GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 25`,
      [appId, rollups.from, to],
    ),
    db.query<{ used: number | null; shared: number | null }>(
      `SELECT sum(count401 + count403 + count429)::int AS used, sum(shared429)::int AS shared
         FROM rest_invalid WHERE app_id = $1 AND ts > now() - interval '10 minutes'`,
      [appId],
    ),
    db.query(
      `SELECT session_start_remaining AS remaining, session_start_total AS total, node_version AS "nodeVersion",
              lib_version AS "libVersion", sdk_version AS "sdkVersion", release, ts
         FROM app_info WHERE app_id = $1`,
      [appId],
    ),
    db.query(
      `SELECT DISTINCT ON (shard) shard, value::float8 AS ping, ts, ts < now() - interval '2 minutes' AS stale
         FROM gauges WHERE app_id = $1 AND name = 'shard.ping_ms' AND ts > now() - interval '1 day'
        ORDER BY shard, ts DESC`,
      [appId],
    ),
    db.query(
      `SELECT ts, shard, state, close_code AS "closeCode", replayed FROM shard_events
        WHERE app_id = $1 AND ts >= $2 AND ts < $3 ORDER BY ts DESC LIMIT 50`,
      [appId, from, to],
    ),
    // Every process of a sharded bot reports these. The bot's figure is the latest sample of each process that was
    // still reporting at the newest sample: added up, except event-loop delay, where the worst process is shown.
    db.query(
      `WITH recent AS (
         SELECT name, instance, shard, value, ts, max(ts) OVER (PARTITION BY name) AS newest FROM gauges
          WHERE app_id = $1 AND name IN ('eventloop.p99_ms', 'memory.rss_bytes', 'memory.heap_used_bytes', 'cache.users', 'cache.channels')
            AND ts > now() - interval '1 day'
       ), latest AS (
         SELECT DISTINCT ON (name, instance, shard) name, value FROM recent
          WHERE ts > newest - interval '2 minutes'
          ORDER BY name, instance, shard, ts DESC
       )
       SELECT name, (CASE WHEN name = 'eventloop.p99_ms' THEN max(value) ELSE sum(value) END)::float8 AS value
         FROM latest GROUP BY name`,
      [appId],
    ),
    db.query(
      `SELECT instance, ts, shards, queue_depth AS "queueDepth", dropped, failed_flushes AS "failedFlushes",
              internal_errors AS "internalErrors", sdk_version AS "sdkVersion"
         FROM sdk_health WHERE app_id = $1 ORDER BY ts DESC LIMIT 50`,
      [appId],
    ),
  ]);
  const used = budget.rows[0]?.used ?? 0;
  return {
    from: rf.toISOString(),
    totals: totals.rows[0] ?? null,
    errorsByCode: codes.rows,
    routes: routes.rows,
    rateLimits: limits.rows,
    invalidBudget: { used, limit: 10_000, share: used / 10_000, shared429: budget.rows[0]?.shared ?? 0 },
    identify: info.rows[0] ?? null,
    shards: shards.rows,
    shardEvents: events.rows,
    process: Object.fromEntries(process.rows.map((r: { name: string; value: number }) => [r.name, r.value])),
    sdkInstances: sdks.rows,
  };
}

/** Premium page: entitlements and subscriptions by SKU, premium share of runs, estimated revenue. */
export async function premium(db: Db, appId: string, range: { from: string; to: string }, now: Date) {
  const from = new Date(range.from);
  const to = new Date(range.to);
  const [skus, prices, changes, active, subs, share] = await Promise.all([
    db.query<{ skus: { id: string; name: string; type: number }[] }>('SELECT skus FROM app_info WHERE app_id = $1', [
      appId,
    ]),
    db.query<{ value: Record<string, { amount: number; currency: string }> }>(
      "SELECT value FROM settings WHERE app_id = $1 AND key = 'sku_prices'",
      [appId],
    ),
    db.query(
      `SELECT sku_id::text AS sku, action, count(*)::int AS count,
              count(*) FILTER (WHERE entitlement_type = 4)::int AS "testCount"
         FROM entitlements WHERE app_id = $1 AND ts >= $2 AND ts < $3 GROUP BY 1, 2 ORDER BY 1, 2`,
      [appId, from, to],
    ),
    db.query(
      `SELECT sku, count(*)::int AS active FROM (
         SELECT DISTINCT ON (sku_id, coalesce(user_hash, '\\x'::bytea), coalesce(guild_id, 0))
                sku_id::text AS sku, action, ends_at
           FROM entitlements WHERE app_id = $1
          ORDER BY sku_id, coalesce(user_hash, '\\x'::bytea), coalesce(guild_id, 0), ts DESC
       ) latest
       WHERE action <> 'delete' AND (ends_at IS NULL OR ends_at > now())
       GROUP BY sku`,
      [appId],
    ),
    db.query(
      `SELECT sku, count(*) FILTER (WHERE status = 0)::int AS active, count(*) FILTER (WHERE status = 1)::int AS ending,
              count(*) FILTER (WHERE status = 2)::int AS inactive
         FROM (SELECT DISTINCT ON (user_hash) unnest(sku_ids)::text AS sku, status FROM subscriptions
                WHERE app_id = $1 ORDER BY user_hash, ts DESC) s
        GROUP BY sku`,
      [appId],
    ),
    db.query<{ share: number | null }>(
      `SELECT (sum(weight) FILTER (WHERE premium) / nullif(sum(weight), 0))::float8 AS share
         FROM interactions WHERE app_id = $1 AND ts >= $2 AND ts < $3`,
      [appId, rawFrom(from, now), to],
    ),
  ]);
  const names = new Map((skus.rows[0]?.skus ?? []).map((s) => [s.id, s.name]));
  const priceMap = prices.rows[0]?.value ?? {};
  const revenue: Record<string, number> = {};
  for (const row of subs.rows as { sku: string; active: number; ending: number }[]) {
    const price = priceMap[row.sku];
    if (price) revenue[price.currency] = (revenue[price.currency] ?? 0) + price.amount * (row.active + row.ending);
  }
  const label = (sku: string) => names.get(sku) ?? sku;
  return {
    changes: (changes.rows as { sku: string }[]).map((r) => ({ ...r, name: label(r.sku) })),
    activeEntitlements: (active.rows as { sku: string }[]).map((r) => ({ ...r, name: label(r.sku) })),
    subscriptions: (subs.rows as { sku: string }[]).map((r) => ({
      ...r,
      name: label(r.sku),
      price: priceMap[r.sku] ?? null,
    })),
    premiumShare: share.rows[0]?.share ?? null,
    estimatedMonthlyRevenue: revenue,
    pricesConfigured: Object.keys(priceMap).length > 0,
  };
}

/** User installs and uninstalls (webhook events) and Discord's approximate counts. */
export async function installs(db: Db, appId: string, range: { from: string; to: string }, timezone: string) {
  const from = new Date(range.from);
  const to = new Date(range.to);
  const [daily, scopes, approx, status] = await Promise.all([
    db.query(
      `SELECT to_char(date_trunc('day', ts AT TIME ZONE $4), 'YYYY-MM-DD') AS day,
              count(*) FILTER (WHERE type = 'APPLICATION_AUTHORIZED' AND integration_type = 1)::int AS "userInstalls",
              count(*) FILTER (WHERE type = 'APPLICATION_DEAUTHORIZED')::int AS "userRemovals",
              count(*) FILTER (WHERE type = 'APPLICATION_AUTHORIZED' AND integration_type = 0)::int AS "serverInstalls"
         FROM webhook_events WHERE app_id = $1 AND ts >= $2 AND ts < $3
        GROUP BY 1 ORDER BY 1`,
      [appId, from, to, timezone],
    ),
    db.query(
      `SELECT s AS scope, count(*)::int AS installs FROM webhook_events, unnest(scopes) AS s
        WHERE app_id = $1 AND ts >= $2 AND ts < $3 AND type = 'APPLICATION_AUTHORIZED' GROUP BY 1 ORDER BY 2 DESC`,
      [appId, from, to],
    ),
    db.query(
      `SELECT to_char(date_trunc('day', ts), 'YYYY-MM-DD') AS day, max(value)::float8 AS value FROM gauges
        WHERE app_id = $1 AND name = 'app.approx_user_installs' AND ts >= $2 AND ts < $3 GROUP BY 1 ORDER BY 1`,
      [appId, from, to],
    ),
    db.query<{ status: number | null }>('SELECT event_webhooks_status AS status FROM app_info WHERE app_id = $1', [
      appId,
    ]),
  ]);
  return {
    daily: daily.rows,
    scopes: scopes.rows,
    approximateUserInstalls: approx.rows,
    webhookStatus: status.rows[0]?.status ?? null,
  };
}

/** Public badge values (opt-in per metric in settings). */
export async function badgeValue(db: Db, appId: string, metric: string): Promise<number | null> {
  if (metric === 'servers') {
    const r = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM guilds WHERE app_id = $1 AND left_at IS NULL',
      [appId],
    );
    return r.rows[0]?.n ?? null;
  }
  if (metric === 'users-monthly') {
    const r = await db.query<{ n: number | null }>(
      `SELECT users AS n FROM unique_counts WHERE app_id = $1 AND grain = 'month' AND scope = 'global'
        ORDER BY start_day DESC LIMIT 1`,
      [appId],
    );
    return r.rows[0]?.n ?? null;
  }
  if (metric === 'commands-daily') {
    const r = await db.query<{ n: number | null }>(
      `SELECT sum(count)::float8 AS n FROM rollup_1h
        WHERE app_id = $1 AND metric = 'interactions' AND bucket > now() - interval '24 hours'`,
      [appId],
    );
    return r.rows[0]?.n ?? 0;
  }
  return null;
}
