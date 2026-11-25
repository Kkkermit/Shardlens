import type { Db } from '../../../db.js';
import { COMMAND_KINDS_SQL, INTERACTIONS_ONLY_SQL, KIND } from '../../../ingest/codes.js';
import { decodeValue, encodeValue } from '../../../query/dimensions.js';
import { QueryError } from '../../../query/error.js';
import { withGuildNames } from '../../../query/guild-names.js';
import type { Filter, Spec } from '../../../query/spec.js';
import { periodBounds, periodLabel, type SaltPeriod } from '../../periods.js';
import type { GuildName, HeatmapCell, QueryAnswer, SeriesRow, TopRow } from '../../store.js';
import { gaugeSamples } from './gauge-samples.js';
import { rawFrom, rollupSource } from './rollup-source.js';
import { countWhenRan, share } from './totals-sql.js';

const DAY = 86_400_000;
const STAT_SQL: Record<string, string> = {
  count: 'sum(count)',
  sum: 'sum(sum)',
  avg: 'sum(sum) / nullif(sum(count), 0)',
  p50: 'shardlens_hist_quantile(shardlens_hist_sum(hist), 0.5)',
  p95: 'shardlens_hist_quantile(shardlens_hist_sum(hist), 0.95)',
  p99: 'shardlens_hist_quantile(shardlens_hist_sum(hist), 0.99)',
};

/** `AND dims->>$k = $v` fragments with bound parameters. */
function filterSql(filters: readonly Filter[], params: unknown[]): string {
  return filters
    .map((f) => {
      params.push(f.field);
      const key = `$${params.length}`;
      if (Array.isArray(f.value) || f.op === 'in') {
        const values = (Array.isArray(f.value) ? f.value : [f.value]).map((v) => encodeValue(f.field, v));
        params.push(values);
        return ` AND dims->>${key} = ANY($${params.length}::text[])`;
      }
      params.push(encodeValue(f.field, f.value));
      return ` AND dims->>${key} = $${params.length}`;
    })
    .join('');
}

/**
 * How stored buckets become chart points: the unit to truncate to, in which time zone. Hourly buckets start on UTC
 * hours, which in India or Newfoundland fall at half past, so they keep their real start (10:30) instead of going under
 * the hour before. Daily buckets, all that is kept after 13 months, are UTC days and keep their UTC date.
 */
function bucketing(table: string, interval: string, timezone: string): [string, string] {
  if (table === 'rollup_1d') return [interval, 'UTC'];
  return [interval === 'hour' ? 'minute' : interval, timezone];
}

export async function series(
  db: Db,
  appId: string,
  spec: Spec<'series'>,
  metric: string,
  now: Date,
): Promise<SeriesRow[]> {
  const { table, from } = rollupSource(new Date(spec.range.from), now, spec.interval === 'minute');
  const to = new Date(spec.range.to);
  const [unit, zone] = bucketing(table, spec.interval, spec.timezone);
  const params: unknown[] = [appId, metric, from, to, unit, zone, spec.limit];
  let keyExpr = "''";
  if (spec.groupBy) {
    params.push(spec.groupBy);
    keyExpr = `coalesce(dims->>$${params.length}, '')`;
  }
  const where = filterSql(spec.filters, params);
  const res = await db.query<SeriesRow>(
    `WITH base AS (
       SELECT date_trunc($5, bucket AT TIME ZONE $6) AS t, ${keyExpr} AS key, count, sum, hist
         FROM ${table}
        WHERE app_id = $1 AND metric = $2 AND bucket >= $3 AND bucket < $4${where}
     ), keys AS (
       SELECT key FROM base GROUP BY key ORDER BY sum(count) DESC LIMIT $7
     )
     SELECT to_char(t, 'YYYY-MM-DD"T"HH24:MI:SS') AS t, key, (${STAT_SQL[spec.stat]})::float8 AS value
       FROM base WHERE key IN (SELECT key FROM keys)
      GROUP BY t, key ORDER BY t`,
    params,
  );
  return res.rows;
}

export async function top(db: Db, appId: string, spec: Spec<'top'>, metric: string, now: Date): Promise<TopRow[]> {
  const { table, from } = rollupSource(new Date(spec.range.from), now);
  const params: unknown[] = [appId, metric, from, new Date(spec.range.to), spec.groupBy, spec.limit];
  const where = filterSql(spec.filters, params);
  const res = await db.query<TopRow>(
    `SELECT coalesce(dims->>$5, '') AS key, (${STAT_SQL[spec.stat]})::float8 AS value, sum(count)::float8 AS count
       FROM ${table}
      WHERE app_id = $1 AND metric = $2 AND bucket >= $3 AND bucket < $4${where}
      GROUP BY 1 ORDER BY 2 DESC NULLS LAST LIMIT $6`,
    params,
  );
  return res.rows;
}

export async function guildNames(db: Db, appId: string, ids: readonly string[]): Promise<GuildName[]> {
  const names = await db.query<GuildName>(
    'SELECT guild_id::text AS id, name, icon FROM guilds WHERE app_id = $1 AND guild_id = ANY($2::bigint[])',
    [appId, ids],
  );
  return names.rows;
}

export async function heatmap(
  db: Db,
  appId: string,
  spec: Spec<'heatmap'>,
  metric: string,
  now: Date,
): Promise<HeatmapCell[]> {
  // Hours of the day need hourly buckets: they cover 13 months, and daily ones would put everything at midnight.
  const asked = new Date(spec.range.from);
  const { table, from } = rollupSource(new Date(Math.max(asked.getTime(), now.getTime() - 395 * DAY)), now);
  const params: unknown[] = [appId, metric, from, new Date(spec.range.to), spec.timezone];
  const where = filterSql(spec.filters, params);
  const res = await db.query<HeatmapCell>(
    `SELECT extract(isodow FROM bucket AT TIME ZONE $5)::int AS weekday,
            extract(hour FROM bucket AT TIME ZONE $5)::int AS hour, sum(count)::float8 AS value
       FROM ${table}
      WHERE app_id = $1 AND metric = $2 AND bucket >= $3 AND bucket < $4${where}
      GROUP BY 1, 2 ORDER BY 1, 2`,
    params,
  );
  return res.rows;
}

async function currentPeriodStart(db: Db, appId: string, now: Date): Promise<string> {
  const app = await db.query<{ salt_period: SaltPeriod }>('SELECT salt_period FROM apps WHERE app_id = $1', [appId]);
  const period = app.rows[0]?.salt_period ?? 'month';
  const bounds = periodBounds(periodLabel(period, now));
  return new Date(bounds?.start ?? now.getTime()).toISOString().slice(0, 10);
}

export async function commands(
  db: Db,
  appId: string,
  spec: Spec<'commands'>,
  now: Date,
): Promise<QueryAnswer<'commands'>> {
  const { table, from } = rollupSource(new Date(spec.range.from), now);
  const to = new Date(spec.range.to);
  const periodStart = await currentPeriodStart(db, appId, now);
  const res = await db.query<Omit<QueryAnswer<'commands'>['rows'][number], 'kinds'> & { kinds: number[] }>(
    `WITH cur AS (
       SELECT dims->>'command' AS command, sum(count) AS runs,
              sum(count) FILTER (WHERE dims->>'outcome' <> '0') AS failures,
              shardlens_hist_sum(hist) AS hist,
              max(bucket) AS last_used, array_agg(DISTINCT (dims->>'kind')::int) AS kinds
         FROM ${table} WHERE app_id = $1 AND metric = 'interactions' AND bucket >= $2 AND bucket < $3
        GROUP BY 1
     ), srv AS (
       SELECT dims->>'command' AS command, count(DISTINCT dims->>'guild') AS servers
         FROM ${table} WHERE app_id = $1 AND metric = 'interactions.by_guild' AND bucket >= $2 AND bucket < $3
        GROUP BY 1
     ), prev AS (
       SELECT dims->>'command' AS command, sum(count) AS runs
         FROM ${table} WHERE app_id = $1 AND metric = 'interactions'
          AND bucket >= $2::timestamptz - ($3::timestamptz - $2::timestamptz) AND bucket < $2
        GROUP BY 1
     ), reg AS (
       -- A registered command's type is its interaction kind (1 slash, 2 user menu, 3 message menu, 4 entry point).
       SELECT name AS command, array_agg(DISTINCT type::int) AS kinds FROM command_registry WHERE app_id = $1 GROUP BY 1
     ), users AS (
       SELECT scope_key AS command, users FROM unique_counts
        WHERE app_id = $1 AND grain = 'month' AND scope = 'command' AND start_day = $4::date
     )
     SELECT coalesce(cur.command, reg.command) AS command,
            coalesce(cur.runs, 0)::float8 AS runs,
            coalesce(prev.runs, 0)::float8 AS "previousRuns",
            CASE WHEN coalesce(prev.runs, 0) = 0 THEN NULL
                 ELSE round((100.0 * (coalesce(cur.runs, 0) - prev.runs) / prev.runs)::numeric, 1)::float8 END AS "changePct",
            CASE WHEN coalesce(cur.runs, 0) = 0 THEN NULL
                 ELSE (coalesce(cur.failures, 0) / cur.runs)::float8 END AS "errorRate",
            shardlens_hist_quantile(cur.hist, 0.95)::float8 AS "p95Ms",
            coalesce(srv.servers, 0)::int AS servers,
            cur.last_used AS "lastUsed",
            users.users AS "uniqueUsersThisPeriod",
            (reg.command IS NOT NULL) AS registered,
            ARRAY(SELECT DISTINCT k FROM unnest(coalesce(cur.kinds, '{}') || coalesce(reg.kinds, '{}')) AS k ORDER BY k)
              AS kinds
       FROM cur FULL JOIN reg USING (command) LEFT JOIN prev USING (command) LEFT JOIN users USING (command)
       LEFT JOIN srv USING (command)
      WHERE coalesce(cur.command, reg.command) IS NOT NULL
      ORDER BY 2 DESC, 1 LIMIT 500`,
    [appId, from, to, periodStart],
  );
  return {
    periodStart,
    rows: res.rows.map((row) => ({ ...row, kinds: row.kinds.map((k) => decodeValue('kind', String(k))) })),
  };
}

export async function command(
  db: Db,
  appId: string,
  spec: Spec<'command'>,
  now: Date,
): Promise<QueryAnswer<'command'>> {
  const from = await rawFrom(db, appId, new Date(spec.range.from), now);
  const to = new Date(spec.range.to);
  const p = [appId, spec.name, from, to];
  const base = `FROM interactions WHERE app_id = $1 AND command = $2 AND ts >= $3 AND ts < $4 AND kind IN ${COMMAND_KINDS_SQL}`;
  const [
    totals,
    kinds,
    subs,
    options,
    values,
    tiers,
    installs,
    contexts,
    channels,
    locales,
    servers,
    components,
    modals,
  ] = await Promise.all([
    db.query(
      `SELECT sum(weight)::float8 AS runs,
                ${countWhenRan('outcome = 0')} AS ok,
                ${countWhenRan('outcome = 1')} AS error,
                ${countWhenRan('outcome = 2')} AS timeout,
                ${countWhenRan('outcome = 3')} AS "noResponse",
                ${share('deferred', INTERACTIONS_ONLY_SQL)} AS "deferRate",
                ${share('ephemeral', INTERACTIONS_ONLY_SQL)} AS "ephemeralRate",
                ${share('premium', INTERACTIONS_ONLY_SQL)} AS "premiumShare",
                ${share('ack_ms > 3000', 'ack_ms IS NOT NULL')} AS "over3sRate",
                shardlens_hist_sum(shardlens_hist_one(ack_ms, weight)) AS latency,
                shardlens_hist_quantile(shardlens_hist_sum(shardlens_hist_one(handler_ms, weight)), 0.95)::float8 AS "handlerP95Ms",
                min(ts) AS "firstSeen", max(ts) AS "lastSeen"
         ${base}`,
      p,
    ),
    db.query(`SELECT kind AS key, sum(weight)::float8 AS value ${base} GROUP BY 1 ORDER BY 2 DESC`, p),
    db.query(
      `SELECT coalesce(cmd_group || ' ', '') || coalesce(sub, '') AS key, sum(weight)::float8 AS value
           ${base} AND (sub IS NOT NULL OR cmd_group IS NOT NULL) GROUP BY 1 ORDER BY 2 DESC LIMIT 50`,
      p,
    ),
    db.query(
      `SELECT o AS key, sum(weight)::float8 AS value FROM (SELECT unnest(options) AS o, weight ${base}) t GROUP BY 1 ORDER BY 2 DESC LIMIT 50`,
      p,
    ),
    db.query(
      `SELECT kv.key AS option, kv.value, sum(weight)::float8 AS runs
           FROM (SELECT option_values, weight ${base} AND option_values IS NOT NULL) t, jsonb_each_text(t.option_values) kv
          GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 100`,
      p,
    ),
    db.query(`SELECT member_tier AS key, sum(weight)::float8 AS value ${base} GROUP BY 1 ORDER BY 2 DESC`, p),
    db.query(
      `SELECT install AS key, sum(weight)::float8 AS value ${base} AND ${INTERACTIONS_ONLY_SQL} GROUP BY 1 ORDER BY 2 DESC`,
      p,
    ),
    db.query(`SELECT context AS key, sum(weight)::float8 AS value ${base} GROUP BY 1 ORDER BY 2 DESC`, p),
    db.query(
      `SELECT channel_type AS key, sum(weight)::float8 AS value ${base} AND channel_type IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`,
      p,
    ),
    db.query(
      `SELECT locale AS key, sum(weight)::float8 AS value ${base} AND locale <> '' GROUP BY 1 ORDER BY 2 DESC LIMIT 15`,
      p,
    ),
    db.query(
      `SELECT guild_id::text AS key, sum(weight)::float8 AS value ${base} AND guild_id IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 10`,
      p,
    ),
    db.query(
      `SELECT custom_id AS key, kind, sum(weight)::float8 AS value
           FROM interactions WHERE app_id = $1 AND source_command = $2 AND ts >= $3 AND ts < $4 AND kind IN (5, 6)
          GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 25`,
      p,
    ),
    db.query(
      `WITH shown AS (
           SELECT custom_id, sum(weight) AS n ${base} AND response_type = 9 AND custom_id IS NOT NULL GROUP BY 1
         ), submitted AS (
           SELECT custom_id, sum(weight) AS n FROM interactions
            WHERE app_id = $1 AND ts >= $3 AND ts < $4 AND kind = 7 AND custom_id IN (SELECT custom_id FROM shown)
            GROUP BY 1
         )
         SELECT shown.custom_id AS "customId", shown.n::float8 AS shown, coalesce(submitted.n, 0)::float8 AS submitted
           FROM shown LEFT JOIN submitted USING (custom_id) ORDER BY 2 DESC LIMIT 20`,
      p,
    ),
  ]);
  const { latency, ...t } = totals.rows[0] as QueryAnswer<'command'>['totals'] & { latency: number[] | null };
  const decode = (field: string, rows: { key: unknown; value: number }[]) =>
    rows.map((r) => ({
      key: r.key === null ? null : decodeValue(field, String(r.key)),
      value: r.value,
    }));
  return {
    from: from.toISOString(),
    totals: t,
    latencyHistogram: latency ?? null,
    // `kind` is never null.
    kinds: kinds.rows.map((r) => ({ key: decodeValue('kind', String(r.key)), value: r.value })),
    subcommands: subs.rows,
    options: options.rows,
    optionValues: values.rows,
    memberTiers: decode('tier', tiers.rows),
    installs: decode('install', installs.rows),
    contexts: contexts.rows.map((r) => ({ key: r.key === null ? null : String(r.key), value: r.value })),
    channelTypes: channels.rows.map((r) => ({ key: String(r.key), value: r.value })),
    locales: locales.rows,
    topServers: await withGuildNames(
      (app, ids) => guildNames(db, app, ids),
      appId,
      servers.rows as { key: string; value: number }[],
    ),
    components: components.rows.map((r) => ({ ...r, kind: decodeValue('kind', String(r.kind)) })),
    modals: modals.rows,
  };
}

const SERVER_SORT: Record<string, string> = {
  members: 'g.member_count',
  joined: 'g.joined_at',
  last_active: 'g.last_command_at',
  runs: 'runs',
  name: 'lower(g.name)',
};
const SIZE_RANGE: Record<string, [number, number]> = {
  '1-10': [1, 10],
  '11-100': [11, 100],
  '101-1k': [101, 1_000],
  '1k-10k': [1_001, 10_000],
  '10k+': [10_001, 2_147_483_647],
};

export async function servers(db: Db, appId: string, spec: Spec<'servers'>) {
  const params: unknown[] = [appId];
  const where: string[] = ['g.app_id = $1'];
  if (spec.status === 'active') where.push('g.left_at IS NULL');
  if (spec.status === 'left') where.push('g.left_at IS NOT NULL');
  if (spec.search) {
    params.push(`%${spec.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    where.push(`g.name ILIKE $${params.length}`);
  }
  if (spec.feature) {
    params.push(spec.feature);
    where.push(`$${params.length} = ANY(g.features)`);
  }
  if (spec.locale) {
    params.push(spec.locale);
    where.push(`g.preferred_locale = $${params.length}`);
  }
  if (spec.size) {
    const [lo, hi] = SIZE_RANGE[spec.size]!;
    params.push(lo, hi);
    where.push(`g.member_count BETWEEN $${params.length - 1} AND $${params.length}`);
  }
  if (spec.inactive) where.push("(g.last_command_at IS NULL OR g.last_command_at < now() - interval '30 days')");
  if (spec.missingPermissions) {
    where.push(`EXISTS (SELECT 1 FROM settings s WHERE s.app_id = g.app_id AND s.key = 'required_permissions'
      AND g.bot_permissions < 9223372036854775808 AND (g.bot_permissions::bigint & 8) = 0
      AND (g.bot_permissions::bigint & (s.value #>> '{}')::bigint) <> (s.value #>> '{}')::bigint)`);
  }
  const order = `${SERVER_SORT[spec.sort]} ${spec.order === 'asc' ? 'ASC' : 'DESC'} NULLS LAST, g.guild_id`;
  const filter = where.join(' AND ');
  const [rows, total] = await Promise.all([
    db.query(
      `SELECT g.guild_id::text AS id, g.name, g.icon, g.member_count AS "memberCount", g.boosts,
              g.premium_tier AS "premiumTier", g.preferred_locale AS locale, g.features, g.joined_at AS "joinedAt",
              g.left_at AS "leftAt", g.shard, g.last_command_at AS "lastActive",
              g.detected_at_startup AS "detectedAtStartup", g.baseline, coalesce(r.runs, 0)::float8 AS runs
         FROM guilds g
         LEFT JOIN (SELECT dims->>'guild' AS gid, sum(count) AS runs FROM rollup_1h
                     WHERE app_id = $1 AND metric = 'interactions.by_guild' AND bucket >= now() - interval '30 days'
                     GROUP BY 1) r ON r.gid = g.guild_id::text
        WHERE ${filter}
        ORDER BY ${order}
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, spec.limit, spec.offset],
    ),
    db.query<{ n: number }>(`SELECT count(*)::int AS n FROM guilds g WHERE ${filter}`, params),
  ]);
  return { total: total.rows[0]?.n ?? 0, rows: rows.rows };
}

type ServerProfile = Extract<QueryAnswer<'server'>, { found: true }>['profile'];

export async function server(db: Db, appId: string, spec: Spec<'server'>, now: Date): Promise<QueryAnswer<'server'>> {
  const periodStart = await currentPeriodStart(db, appId, now);
  const [profile, events, users, required] = await Promise.all([
    db.query<ServerProfile & { botPermissions: string | null }>(
      `SELECT guild_id::text AS id, name, icon, member_count AS "memberCount", size_at_join AS "sizeAtJoin", large,
              preferred_locale AS locale, features, premium_tier AS "premiumTier", boosts,
              verification_level AS "verificationLevel", nsfw_level AS "nsfwLevel", mfa_level AS "mfaLevel",
              created_at AS "createdAt", joined_at AS "joinedAt", left_at AS "leftAt", shard,
              channel_counts AS "channelCounts", role_count AS "roleCount", emoji_count AS "emojiCount",
              sticker_count AS "stickerCount", bot_permissions::text AS "botPermissions",
              detected_at_startup AS "detectedAtStartup", baseline, first_command_at AS "firstCommandAt",
              last_command_at AS "lastCommandAt", updated_at AS "updatedAt"
         FROM guilds WHERE app_id = $1 AND guild_id = $2`,
      [appId, spec.guild],
    ),
    db.query(
      `SELECT ts, CASE kind WHEN 1 THEN 'join' WHEN 2 THEN 'leave' WHEN 3 THEN 'unavailable' ELSE 'available' END AS kind,
              detected_at_startup AS "detectedAtStartup"
         FROM guild_events WHERE app_id = $1 AND guild_id = $2 ORDER BY ts DESC LIMIT 100`,
      [appId, spec.guild],
    ),
    db.query<{ users: number }>(
      `SELECT users FROM unique_counts WHERE app_id = $1 AND grain = 'month' AND scope = 'guild'
          AND scope_key = $2 AND start_day = $3::date`,
      [appId, spec.guild, periodStart],
    ),
    db.query<{ value: string }>(
      "SELECT value #>> '{}' AS value FROM settings WHERE app_id = $1 AND key = 'required_permissions'",
      [appId],
    ),
  ]);
  const row = profile.rows[0];
  if (!row) return { found: false };
  const requiredBits = required.rows[0]?.value;
  let missingPermissions: string | null = null;
  if (requiredBits && row.botPermissions) {
    const have = BigInt(row.botPermissions);
    const need = BigInt(requiredBits);
    missingPermissions = (have & 8n) === 8n ? '0' : (need & ~have).toString();
  }
  return {
    found: true,
    profile: row,
    events: events.rows,
    uniqueUsersThisPeriod: users.rows[0]?.users ?? null,
    periodStart,
    missingPermissions,
  };
}

export async function growth(db: Db, appId: string, spec: Spec<'growth'>, now: Date): Promise<QueryAnswer<'growth'>> {
  const from = new Date(spec.range.from);
  const to = new Date(spec.range.to);
  const rollups = rollupSource(from, now);
  const p = [appId, from, to];
  const [daily, sizes, activation, inactive, cohorts, lifetimes, approx, counts] = await Promise.all([
    db.query(
      `SELECT to_char(date_trunc('day', bucket AT TIME ZONE $4), 'YYYY-MM-DD') AS day,
              sum(count) FILTER (WHERE metric = 'guild.joins')::float8 AS joins,
              sum(count) FILTER (WHERE metric = 'guild.leaves')::float8 AS leaves,
              sum(count) FILTER (WHERE metric = 'guild.joins' AND dims->>'detected' = 'true')::float8 AS "joinsDetected",
              sum(count) FILTER (WHERE metric = 'guild.leaves' AND dims->>'detected' = 'true')::float8 AS "leavesDetected"
         FROM ${rollups.table}
        WHERE app_id = $1 AND metric IN ('guild.joins', 'guild.leaves') AND bucket >= $2 AND bucket < $3
        GROUP BY 1 ORDER BY 1`,
      [appId, rollups.from, to, spec.timezone],
    ),
    db.query(
      `SELECT CASE WHEN size_at_join <= 10 THEN '1-10' WHEN size_at_join <= 100 THEN '11-100'
                   WHEN size_at_join <= 1000 THEN '101-1k' WHEN size_at_join <= 10000 THEN '1k-10k' ELSE '10k+' END AS bucket,
              count(*)::int AS servers
         FROM guilds WHERE app_id = $1 AND joined_at >= $2 AND joined_at < $3 AND NOT baseline AND size_at_join IS NOT NULL
        GROUP BY 1`,
      p,
    ),
    db.query(
      `SELECT count(*)::int AS joined,
              count(*) FILTER (WHERE first_command_at IS NOT NULL AND first_command_at < joined_at + interval '24 hours')::int AS activated
         FROM guilds WHERE app_id = $1 AND joined_at >= $2 AND joined_at < $3 AND NOT baseline AND NOT detected_at_startup`,
      p,
    ),
    db.query(
      `SELECT count(*)::int AS active,
              count(*) FILTER (WHERE last_command_at IS NULL OR last_command_at < now() - interval '30 days')::int AS inactive
         FROM guilds WHERE app_id = $1 AND left_at IS NULL`,
      [appId],
    ),
    db.query(
      `SELECT to_char(date_trunc('week', g.joined_at), 'YYYY-MM-DD') AS cohort,
              floor(extract(epoch FROM (r.bucket - date_trunc('week', g.joined_at))) / 604800)::int AS week,
              count(DISTINCT g.guild_id)::int AS servers
         FROM guilds g
         JOIN rollup_1d r ON r.app_id = g.app_id AND r.metric = 'interactions.by_guild' AND r.dims->>'guild' = g.guild_id::text
                         AND r.bucket >= date_trunc('week', g.joined_at)
        WHERE g.app_id = $1 AND g.joined_at >= $2 AND g.joined_at < $3 AND NOT g.baseline
        GROUP BY 1, 2 ORDER BY 1, 2`,
      p,
    ),
    db.query(
      `SELECT CASE WHEN d < 1 THEN '<1d' WHEN d < 7 THEN '1-7d' WHEN d < 30 THEN '7-30d' WHEN d < 90 THEN '30-90d' ELSE '90d+' END AS bucket,
              count(*)::int AS servers
         FROM (SELECT extract(epoch FROM (left_at - joined_at)) / 86400 AS d FROM guilds
                WHERE app_id = $1 AND left_at >= $2 AND left_at < $3 AND NOT baseline) t
        GROUP BY 1`,
      p,
    ),
    db.query(
      `SELECT to_char(date_trunc('day', ts), 'YYYY-MM-DD') AS day, max(value)::float8 AS value
         FROM gauges WHERE app_id = $1 AND name = 'app.approx_guilds' AND ts >= $2 AND ts < $3
        GROUP BY 1 ORDER BY 1`,
      p,
    ),
    db.query<{ ours: number; approx: number | null; approx_at: Date | null }>(
      `SELECT (SELECT count(*)::int FROM guilds WHERE app_id = $1 AND left_at IS NULL) AS ours,
              (SELECT approx_guilds FROM app_info WHERE app_id = $1) AS approx,
              (SELECT ts FROM app_info WHERE app_id = $1) AS approx_at`,
      [appId],
    ),
  ]);
  const c = counts.rows[0];
  const drift = c?.approx ? (c.ours - c.approx) / c.approx : null;
  // An aggregate without GROUP BY always has its one row.
  const act = activation.rows[0] as { joined: number; activated: number };
  return {
    daily: daily.rows,
    sizeAtInstall: sizes.rows,
    activation: { ...act, rate: act && act.joined > 0 ? act.activated / act.joined : null },
    installs: inactive.rows[0],
    cohorts: cohorts.rows,
    lifetimes: lifetimes.rows,
    approximateGuilds: approx.rows,
    serverCount: {
      ours: c?.ours ?? 0,
      discord: c?.approx ?? null,
      at: c?.approx_at ?? null,
      drift,
      warn: drift !== null && Math.abs(drift) > 0.02,
    },
  };
}

export async function audience(db: Db, appId: string, spec: Spec<'audience'>, now: Date) {
  const from = new Date(spec.range.from);
  const to = new Date(spec.range.to);
  const day = (d: Date) => d.toISOString().slice(0, 10);
  // Unique users are counted per UTC day. `to` is exclusive, so the last day is the one its final millisecond is in:
  // a range ending now includes today.
  const days = [appId, day(from), day(new Date(to.getTime() - 1))];
  const rollups = rollupSource(from, now);
  const rawStart = await rawFrom(db, appId, from, now);
  const [daily, weekly, periods, splits, premium] = await Promise.all([
    db.query(
      `SELECT to_char(start_day, 'YYYY-MM-DD') AS day, users, new_users AS "newUsers" FROM unique_counts
        WHERE app_id = $1 AND grain = 'day' AND scope = 'global' AND start_day >= $2::date AND start_day <= $3::date
        ORDER BY start_day`,
      days,
    ),
    db.query(
      `SELECT to_char(start_day, 'YYYY-MM-DD') AS week, users FROM unique_counts
        WHERE app_id = $1 AND grain = 'week' AND scope = 'global' AND start_day >= $2::date - 6 AND start_day <= $3::date
        ORDER BY start_day`,
      days,
    ),
    db.query(
      `SELECT to_char(start_day, 'YYYY-MM-DD') AS period, users, final FROM unique_counts
        WHERE app_id = $1 AND grain = 'month' AND scope = 'global' AND start_day <= $3::date
          AND start_day >= $2::date - 31
        ORDER BY start_day`,
      days,
    ),
    db.query(
      `SELECT k AS dimension, dims->>k AS key, sum(count)::float8 AS value
         FROM ${rollups.table}, unnest(ARRAY['locale', 'install', 'context', 'tier']) AS k
        WHERE app_id = $1 AND metric = 'interactions' AND bucket >= $2 AND bucket < $3
          AND NOT (k IN ('locale', 'install') AND dims->>'kind' = '${KIND.message_command}')
        GROUP BY 1, 2 ORDER BY 1, 3 DESC`,
      [appId, rollups.from, to],
    ),
    db.query<{ share: number | null }>(
      `SELECT (sum(weight) FILTER (WHERE premium) / nullif(sum(weight), 0))::float8 AS share
         FROM interactions WHERE app_id = $1 AND ts >= $2 AND ts < $3 AND ${INTERACTIONS_ONLY_SQL}`,
      [appId, rawStart, to],
    ),
  ]);
  const dau = daily.rows as { users: number }[];
  const latestPeriod = (periods.rows as { users: number }[]).at(-1);
  const recent = dau.slice(-30);
  const avgDau = recent.length > 0 ? recent.reduce((a, r) => a + r.users, 0) / recent.length : null;
  const grouped: Record<string, { key: string | null; value: number }[]> = {};
  for (const r of splits.rows as { dimension: string; key: string | null; value: number }[]) {
    const list = grouped[r.dimension] ?? [];
    list.push({ key: decodeValue(r.dimension, r.key), value: r.value });
    grouped[r.dimension] = list;
  }
  for (const k of Object.keys(grouped)) grouped[k] = grouped[k]!.slice(0, 15);
  return {
    daily: daily.rows,
    weekly: weekly.rows,
    periods: periods.rows,
    stickiness: avgDau !== null && latestPeriod?.users ? avgDau / latestPeriod.users : null,
    splits: grouped,
    premiumShare: premium.rows[0]?.share ?? null,
  };
}

export async function overview(db: Db, appId: string, now: Date): Promise<QueryAnswer<'overview'>> {
  const periodStart = await currentPeriodStart(db, appId, now);
  const from = new Date(now.getTime() - 30 * DAY);
  const [app, info, sdks, runs, servers, mau, lastEvent, required] = await Promise.all([
    db.query(
      'SELECT app_id::text AS id, name, mode, salt_period AS "saltPeriod", timezone, raw_retention_days AS "rawRetentionDays" FROM apps WHERE app_id = $1',
      [appId],
    ),
    db.query<NonNullable<QueryAnswer<'overview'>['appInfo']>>(
      `SELECT ts, name, approx_guilds AS "approxGuilds", approx_user_installs AS "approxUserInstalls",
              approx_user_auths AS "approxUserAuthorizations", event_webhooks_status AS "eventWebhooksStatus",
              session_start_remaining AS "sessionStartRemaining", session_start_total AS "sessionStartTotal",
              node_version AS "nodeVersion", lib_version AS "libVersion", sdk_version AS "sdkVersion", release
         FROM app_info WHERE app_id = $1`,
      [appId],
    ),
    db.query(
      `SELECT instance, ts, shards, queue_depth AS "queueDepth", dropped, failed_flushes AS "failedFlushes",
              internal_errors AS "internalErrors", sdk_version AS "sdkVersion"
         FROM sdk_health WHERE app_id = $1 ORDER BY ts DESC LIMIT 50`,
      [appId],
    ),
    db.query(
      `SELECT to_char(date_trunc('day', bucket), 'YYYY-MM-DD') AS day, sum(count)::float8 AS runs,
              sum(count) FILTER (WHERE dims->>'outcome' <> '0')::float8 AS failures
         FROM rollup_1h WHERE app_id = $1 AND metric = 'interactions' AND bucket >= $2
        GROUP BY 1 ORDER BY 1`,
      [appId, from],
    ),
    db.query<{ active: number }>('SELECT count(*)::int AS active FROM guilds WHERE app_id = $1 AND left_at IS NULL', [
      appId,
    ]),
    db.query<{ users: number }>(
      `SELECT users FROM unique_counts WHERE app_id = $1 AND grain = 'month' AND scope = 'global' AND start_day = $2::date`,
      [appId, periodStart],
    ),
    db.query<{ ts: Date | null }>(
      "SELECT max(bucket) AS ts FROM rollup_1m WHERE app_id = $1 AND bucket > now() - interval '14 days'",
      [appId],
    ),
    db.query("SELECT 1 FROM settings WHERE app_id = $1 AND key = 'required_permissions'", [appId]),
  ]);
  const appInfo = info.rows[0];
  return {
    app: app.rows[0] ?? null,
    appInfo: appInfo ?? null,
    sdkInstances: sdks.rows,
    runs30d: runs.rows,
    servers: servers.rows[0]?.active ?? 0,
    uniqueUsersThisPeriod: mau.rows[0]?.users ?? null,
    periodStart,
    lastEventAt: lastEvent.rows[0]?.ts ?? null,
    checklist: {
      receivingEvents: lastEvent.rows[0]?.ts != null,
      appInfoReceived: appInfo !== undefined,
      webhookEventsEnabled: appInfo?.eventWebhooksStatus === 2,
      requiredPermissionsSet: (required.rowCount ?? 0) > 0,
    },
  };
}

/** Gauges that count something each shard or process holds, so the bot's figure is their sum. Others are averaged. */
const ADDITIVE_GAUGES = new Set([
  'shard.guilds',
  'memory.rss_bytes',
  'memory.heap_used_bytes',
  'cache.users',
  'cache.channels',
]);

export async function gauge(db: Db, appId: string, spec: Spec<'gauge'>) {
  const from = new Date(spec.range.from);
  const to = new Date(spec.range.to);
  if (spec.interval === 'minute' && to.getTime() - from.getTime() > 2 * DAY) {
    throw new QueryError('minute series are limited to 2 days');
  }
  // Every shard and process reports its own samples. They are combined minute by minute (added up, or averaged for
  // a latency) before the minutes are averaged into the interval, keeping one process per slot in each minute.
  const additive = ADDITIVE_GAUGES.has(spec.name);
  const shard = spec.perShard ? 'shard' : 'NULL::int';
  const res = await db.query(
    `WITH per_source AS (
       SELECT DISTINCT ON (minute, slot) minute, shard, value, max FROM (
         SELECT date_trunc('minute', ts) AS minute, slot, shard, instance, avg(value) AS value, max(value) AS max,
                max(ts) AS last
           FROM (${gaugeSamples('g.app_id = $1 AND g.name = $2 AND g.ts >= $3 AND g.ts < $4')}) samples
          GROUP BY 1, 2, 3, 4
       ) s ORDER BY minute, slot, last DESC
     ), per_minute AS (
       SELECT minute, ${shard} AS shard,
              ${additive ? 'sum(value)' : 'avg(value)'} AS value, ${additive ? 'sum(max)' : 'max(max)'} AS max
         FROM per_source GROUP BY 1, 2
     )
     SELECT to_char(date_trunc($5, minute AT TIME ZONE $6), 'YYYY-MM-DD"T"HH24:MI:SS') AS t, shard,
            avg(value)::float8 AS value, max(max)::float8 AS max
       FROM per_minute GROUP BY 1, 2 ORDER BY 1, 2 LIMIT 20000`,
    [appId, spec.name, from, to, spec.interval, spec.timezone],
  );
  return { timezone: spec.timezone, points: res.rows };
}

export async function bursts(db: Db, appId: string, spec: Spec<'bursts'>, now: Date) {
  const from = new Date(Math.max(Date.parse(spec.range.from), now.getTime() - 14 * DAY));
  const res = await db.query(
    `WITH m AS (
       SELECT bucket, sum(count) AS n FROM rollup_1m
        WHERE app_id = $1 AND metric = 'interactions' AND bucket >= $2 AND bucket < $3 GROUP BY 1
     ), med AS (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY n) AS median FROM m)
     SELECT m.bucket AS minute, m.n::float8 AS runs, med.median::float8 AS median
       FROM m, med WHERE med.median > 0 AND m.n > med.median * $4 ORDER BY m.n DESC LIMIT 100`,
    [appId, from, new Date(spec.range.to), spec.factor],
  );
  return { rows: res.rows };
}
