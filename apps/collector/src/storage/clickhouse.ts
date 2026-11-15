import { type ClickHouseClient, createClient } from '@clickhouse/client';
import type { Filter } from '../query/spec.js';

/**
 * ClickHouse analytics store (preview). PostgreSQL stays the system of record. When `CLICKHOUSE_URL` is set, ingest
 * mirrors the interactions and custom events PostgreSQL accepted, and series, top and heatmap queries for those
 * metrics are answered from ClickHouse's minute rollups for any range it fully covers.
 *
 * Queries use ClickHouse's typed parameters (`{name:Type}`); identifiers come from fixed maps, never input. Mirroring
 * never blocks or fails ingest: rows wait in a bounded buffer and are dropped (and counted) when it is full.
 */

const TABLES = [
  `CREATE TABLE IF NOT EXISTS interactions (
     id UUID, ts DateTime64(3, 'UTC'), app_id UInt64, kind UInt8, command LowCardinality(String),
     sub LowCardinality(String), outcome UInt8, context Int8, install Int8, guild_id UInt64,
     locale LowCardinality(String), tier Int8, user_hash FixedString(32), ack_ms Nullable(UInt32), weight Float32
   ) ENGINE = MergeTree PARTITION BY toYYYYMMDD(ts) ORDER BY (app_id, ts, id)
     TTL toDateTime(ts) + INTERVAL 35 DAY`,
  `CREATE TABLE IF NOT EXISTS interactions_1m (
     app_id UInt64, bucket DateTime('UTC'), kind UInt8, command LowCardinality(String), sub LowCardinality(String),
     outcome UInt8, context Int8, install Int8, guild_id UInt64, locale LowCardinality(String), tier Int8,
     runs AggregateFunction(sum, Float64), ack_sum AggregateFunction(sum, Float64),
     ack_q AggregateFunction(quantilesTDigestIf(0.5, 0.95, 0.99), UInt32, UInt8),
     users AggregateFunction(uniq, FixedString(32))
   ) ENGINE = AggregatingMergeTree PARTITION BY toYYYYMM(bucket)
     ORDER BY (app_id, bucket, kind, command, sub, outcome, context, install, guild_id, locale, tier)
     TTL bucket + INTERVAL 400 DAY`,
  `CREATE MATERIALIZED VIEW IF NOT EXISTS interactions_1m_mv TO interactions_1m AS
   SELECT app_id, toStartOfMinute(ts) AS bucket, kind, command, sub, outcome, context, install, guild_id, locale, tier,
          sumState(toFloat64(weight)) AS runs,
          sumState(toFloat64(ifNull(ack_ms, 0)) * weight) AS ack_sum,
          quantilesTDigestIfState(0.5, 0.95, 0.99)(ifNull(ack_ms, 0), toUInt8(isNotNull(ack_ms))) AS ack_q,
          uniqState(user_hash) AS users
     FROM interactions
    GROUP BY app_id, bucket, kind, command, sub, outcome, context, install, guild_id, locale, tier`,
  `CREATE TABLE IF NOT EXISTS custom_events (
     id UUID, ts DateTime64(3, 'UTC'), app_id UInt64, name LowCardinality(String), user_hash Nullable(FixedString(32)),
     guild_id UInt64, weight Float32
   ) ENGINE = MergeTree PARTITION BY toYYYYMMDD(ts) ORDER BY (app_id, name, ts, id)
     TTL toDateTime(ts) + INTERVAL 35 DAY`,
  `CREATE TABLE IF NOT EXISTS custom_1m (
     app_id UInt64, bucket DateTime('UTC'), name LowCardinality(String), guild_id UInt64,
     runs AggregateFunction(sum, Float64), users AggregateFunction(uniq, Nullable(FixedString(32)))
   ) ENGINE = AggregatingMergeTree PARTITION BY toYYYYMM(bucket) ORDER BY (app_id, bucket, name, guild_id)
     TTL bucket + INTERVAL 400 DAY`,
  `CREATE MATERIALIZED VIEW IF NOT EXISTS custom_1m_mv TO custom_1m AS
   SELECT app_id, toStartOfMinute(ts) AS bucket, name, guild_id,
          sumState(toFloat64(weight)) AS runs, uniqState(user_hash) AS users
     FROM custom_events GROUP BY app_id, bucket, name, guild_id`,
  `CREATE TABLE IF NOT EXISTS shardlens_meta (key String, value String, at DateTime DEFAULT now())
   ENGINE = ReplacingMergeTree(at) ORDER BY key`,
];

/** A mirrored interaction, with the codes PostgreSQL stores. */
export interface MirroredInteraction {
  id: string;
  ts: Date;
  appId: string;
  kind: number;
  command: string | null;
  sub: string | null;
  outcome: number;
  context: number | null;
  install: number | null;
  guildId: string | null;
  locale: string;
  tier: number | null;
  userHash: Buffer;
  ackMs: number | null;
  weight: number;
}

export interface MirroredCustom {
  id: string;
  ts: Date;
  appId: string;
  name: string;
  userHash: Buffer | null;
  guildId: string | null;
  weight: number;
}

/** Rollup dimensions ClickHouse can answer, mapped to columns. Anything else falls back to PostgreSQL. */
const INTERACTION_COLUMNS: Record<string, string> = {
  kind: 'kind',
  command: 'command',
  sub: 'sub',
  outcome: 'outcome',
  context: 'context',
  install: 'install',
  guild: 'guild_id',
  locale: 'locale',
  tier: 'tier',
};
const CUSTOM_COLUMNS: Record<string, string> = { guild: 'guild_id' };

/** Columns stored as integers, so filter values are compared as numbers. */
const NUMERIC = new Set(['kind', 'outcome', 'context', 'install', 'tier', 'guild_id']);

const STAT: Record<string, { interactions: string; custom?: string }> = {
  count: { interactions: 'sumMerge(runs)', custom: 'sumMerge(runs)' },
  sum: { interactions: 'sumMerge(ack_sum)' },
  avg: { interactions: 'sumMerge(ack_sum) / nullIf(sumMerge(runs), 0)' },
  p50: { interactions: 'quantilesTDigestIfMerge(0.5, 0.95, 0.99)(ack_q)[1]' },
  p95: { interactions: 'quantilesTDigestIfMerge(0.5, 0.95, 0.99)(ack_q)[2]' },
  p99: { interactions: 'quantilesTDigestIfMerge(0.5, 0.95, 0.99)(ack_q)[3]' },
};

const BUCKET: Record<string, string> = {
  minute: 'toStartOfMinute(bucket, {tz:String})',
  hour: 'toStartOfHour(bucket, {tz:String})',
  day: 'toStartOfDay(bucket, {tz:String})',
  week: 'toMonday(bucket, {tz:String})',
  month: 'toStartOfMonth(bucket, {tz:String})',
};

/** A query the store can answer: rollup table, metric condition, and column lookups. */
interface Target {
  table: 'interactions_1m' | 'custom_1m';
  columns: Record<string, string>;
  where: string;
  stat: string;
}

const MAX_BUFFER = 50_000;
const FLUSH_MS = 1_000;

export interface AnalyticsQuery {
  metric: string;
  name?: string | undefined;
  from: Date;
  to: Date;
  filters: readonly Filter[];
  groupBy?: string | undefined;
  stat: string;
}

export class ClickHouseStore {
  readonly #client: ClickHouseClient;
  readonly #url: URL;
  #interactions: MirroredInteraction[] = [];
  #custom: MirroredCustom[] = [];
  #timer: ReturnType<typeof setInterval> | undefined;
  #flushing: Promise<void> | undefined;
  #since: number | undefined;
  #warn: (message: string) => void = () => undefined;
  /** Rows dropped because the buffer was full or ClickHouse refused them (exposed in logs). */
  dropped = 0;

  constructor(url: string) {
    this.#url = new URL(url);
    if (this.#url.pathname === '/' || this.#url.pathname === '') this.#url.pathname = '/shardlens';
    this.#client = createClient({ url: this.#url, request_timeout: 15_000 });
  }

  get database(): string {
    return this.#url.pathname.replace(/^\//, '');
  }

  /** Creates the database, tables and views if needed, and records when mirroring started. */
  async migrate(): Promise<void> {
    const admin = new URL(this.#url);
    admin.pathname = '/';
    const adminClient = createClient({ url: admin });
    try {
      // The database name comes from the operator's URL, not from requests; it is still checked.
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(this.database)) throw new Error('invalid ClickHouse database name');
      await adminClient.command({ query: `CREATE DATABASE IF NOT EXISTS ${this.database}` });
    } finally {
      await adminClient.close();
    }
    for (const query of TABLES) await this.#client.command({ query });
    // The collector's clock, like the event timestamps it compares against (ClickHouse's clock may differ).
    await this.#client.command({
      query: `INSERT INTO shardlens_meta (key, value)
              SELECT 'since', {now:String}
               WHERE NOT EXISTS (SELECT 1 FROM shardlens_meta WHERE key = 'since')`,
      query_params: { now: String(Date.now()) },
    });
    this.#since = await this.#readSince();
  }

  /** Starts sending buffered rows. `warn` receives a message when an insert fails. */
  start(warn?: (message: string) => void): void {
    if (warn) this.#warn = warn;
    this.#timer ??= setInterval(() => void this.flush(), FLUSH_MS);
    this.#timer.unref();
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.flush();
    await this.#client.close();
  }

  /** Queues rows PostgreSQL accepted. Never throws, never blocks. */
  mirror(rows: { interactions: readonly MirroredInteraction[]; custom: readonly MirroredCustom[] }): void {
    const room = MAX_BUFFER - this.#interactions.length - this.#custom.length;
    const total = rows.interactions.length + rows.custom.length;
    if (total > room) {
      this.dropped += total;
      return;
    }
    this.#interactions.push(...rows.interactions);
    this.#custom.push(...rows.custom);
  }

  /** Sends buffered rows. A failed insert keeps the rows for the next try (bounded by the buffer size). */
  flush(): Promise<void> {
    this.#flushing ??= this.#flush().finally(() => {
      this.#flushing = undefined;
    });
    return this.#flushing;
  }

  async #flush(): Promise<void> {
    const interactions = this.#interactions;
    const custom = this.#custom;
    if (interactions.length === 0 && custom.length === 0) return;
    this.#interactions = [];
    this.#custom = [];
    try {
      if (interactions.length > 0) {
        await this.#client.insert({
          table: 'interactions',
          format: 'JSONEachRow',
          values: interactions.map((r) => ({
            id: r.id,
            ts: r.ts.toISOString(),
            app_id: r.appId,
            kind: r.kind,
            command: r.command ?? '',
            sub: r.sub ?? '',
            outcome: r.outcome,
            context: r.context ?? -1,
            install: r.install ?? -1,
            guild_id: r.guildId ?? '0',
            locale: r.locale,
            tier: r.tier ?? -1,
            user_hash: r.userHash.toString('hex'),
            ack_ms: r.ackMs,
            weight: r.weight,
          })),
          clickhouse_settings: { date_time_input_format: 'best_effort' },
        });
      }
      if (custom.length > 0) {
        await this.#client.insert({
          table: 'custom_events',
          format: 'JSONEachRow',
          values: custom.map((r) => ({
            id: r.id,
            ts: r.ts.toISOString(),
            app_id: r.appId,
            name: r.name,
            user_hash: r.userHash ? r.userHash.toString('hex') : null,
            guild_id: r.guildId ?? '0',
            weight: r.weight,
          })),
          clickhouse_settings: { date_time_input_format: 'best_effort' },
        });
      }
    } catch (error) {
      // Put the rows back (oldest first) if they still fit; otherwise drop and count them.
      const keep = MAX_BUFFER - this.#interactions.length - this.#custom.length;
      if (interactions.length + custom.length <= keep) {
        this.#interactions = [...interactions, ...this.#interactions];
        this.#custom = [...custom, ...this.#custom];
      } else this.dropped += interactions.length + custom.length;
      this.#warn(`ClickHouse insert failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  /** Right to erasure: deletes a person's raw rows (their rollups are anonymous counts and sketches). */
  async erase(appId: string, hashes: readonly Buffer[]): Promise<void> {
    if (hashes.length === 0) return;
    const values = hashes.map((h) => h.toString('hex'));
    for (const table of ['interactions', 'custom_events']) {
      await this.#client.command({
        query: `DELETE FROM ${table} WHERE app_id = {app:UInt64} AND user_hash IN {hashes:Array(String)}`,
        query_params: { app: appId, hashes: values },
      });
    }
  }

  async #readSince(): Promise<number | undefined> {
    const rs = await this.#client.query({
      query: "SELECT value FROM shardlens_meta FINAL WHERE key = 'since'",
      format: 'JSONEachRow',
    });
    const rows = (await rs.json()) as { value: string }[];
    const since = Number(rows[0]?.value);
    return Number.isFinite(since) ? since : undefined;
  }

  /**
   * Whether ClickHouse can answer this query: the metric and every dimension and stat are covered, and the range
   * starts after mirroring began (older data only exists in PostgreSQL).
   */
  #target(q: AnalyticsQuery): Target | undefined {
    if (this.#since === undefined || q.from.getTime() < this.#since) return undefined;
    const fields = [...(q.groupBy ? [q.groupBy] : []), ...q.filters.map((f) => f.field)];
    if (q.metric === 'interactions' || q.metric === 'interactions.by_guild') {
      const stat = STAT[q.stat]?.interactions;
      if (!stat || fields.some((f) => !(f in INTERACTION_COLUMNS))) return undefined;
      // Like PostgreSQL's `interactions` metric: commands, context menus, entry points (kinds 1–4) and message commands (9).
      const kinds = ' AND (kind <= 4 OR kind = 9)';
      const where = q.metric === 'interactions.by_guild' ? `${kinds} AND guild_id > 0` : kinds;
      return { table: 'interactions_1m', columns: INTERACTION_COLUMNS, where, stat };
    }
    if (q.metric.startsWith('custom.')) {
      const stat = STAT[q.stat]?.custom;
      if (!stat || fields.some((f) => !(f in CUSTOM_COLUMNS))) return undefined;
      return { table: 'custom_1m', columns: CUSTOM_COLUMNS, where: ' AND name = {name:String}', stat };
    }
    return undefined;
  }

  #filters(target: Target, filters: readonly Filter[], params: Record<string, unknown>): string {
    return filters
      .map((f, i) => {
        const column = target.columns[f.field] as string;
        const values = Array.isArray(f.value) ? f.value : [f.value];
        const type = NUMERIC.has(column) ? 'Array(Int64)' : 'Array(String)';
        params[`f${i}`] = NUMERIC.has(column) ? values.map((v) => (v === '' ? -1 : Number(v))) : values;
        return ` AND ${column} IN {f${i}:${type}}`;
      })
      .join('');
  }

  #params(q: AnalyticsQuery, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      app: '',
      // Minute buckets: include the minute `from` falls in.
      from: Math.floor(q.from.getTime() / 60_000) * 60,
      to: Math.floor(q.to.getTime() / 1000),
      ...(q.metric.startsWith('custom.') ? { name: q.metric.slice('custom.'.length) } : {}),
      ...extra,
    };
  }

  /** Time series, or `undefined` if ClickHouse can't answer it. Values match the PostgreSQL query's shape. */
  async series(
    appId: string,
    q: AnalyticsQuery & { interval: string; timezone: string; limit: number },
    encode: (field: string, value: string) => string,
  ): Promise<{ t: string; key: string | null; value: number | null }[] | undefined> {
    const target = this.#target(q);
    const bucket = BUCKET[q.interval];
    if (!target || !bucket) return undefined;
    const params = this.#params(q, { app: appId, tz: q.timezone, limit: q.limit });
    const where = this.#filters(target, this.#encoded(q.filters, encode), params);
    const key = q.groupBy ? `toString(${target.columns[q.groupBy]})` : "''";
    const rs = await this.#client.query({
      query: `WITH keys AS (
                SELECT ${key} AS key FROM ${target.table}
                 WHERE app_id = {app:UInt64} AND bucket >= toDateTime({from:UInt32}) AND bucket < toDateTime({to:UInt32})${target.where}${where}
                 GROUP BY key ORDER BY sumMerge(runs) DESC LIMIT {limit:UInt32})
              SELECT formatDateTime(${bucket}, '%Y-%m-%dT%H:%i:%S', {tz:String}) AS t, ${key} AS key,
                     toFloat64(${target.stat}) AS value
                FROM ${target.table}
               WHERE app_id = {app:UInt64} AND bucket >= toDateTime({from:UInt32}) AND bucket < toDateTime({to:UInt32})${target.where}${where}
                 AND ${key} IN (SELECT key FROM keys)
               GROUP BY t, key ORDER BY t`,
      query_params: params,
      format: 'JSONEachRow',
    });
    return (await rs.json()) as { t: string; key: string; value: number | null }[];
  }

  /** Top values of one dimension, or `undefined` if ClickHouse can't answer it. */
  async top(
    appId: string,
    q: AnalyticsQuery & { groupBy: string; limit: number },
    encode: (field: string, value: string) => string,
  ): Promise<{ key: string; value: number | null; count: number }[] | undefined> {
    const target = this.#target(q);
    if (!target) return undefined;
    const params = this.#params(q, { app: appId, limit: q.limit });
    const where = this.#filters(target, this.#encoded(q.filters, encode), params);
    const column = target.columns[q.groupBy] as string;
    const rs = await this.#client.query({
      query: `SELECT toString(${column}) AS key, toFloat64(${target.stat}) AS value, toFloat64(sumMerge(runs)) AS count
                FROM ${target.table}
               WHERE app_id = {app:UInt64} AND bucket >= toDateTime({from:UInt32}) AND bucket < toDateTime({to:UInt32})${target.where}${where}
               GROUP BY key ORDER BY value DESC LIMIT {limit:UInt32}`,
      query_params: params,
      format: 'JSONEachRow',
    });
    // Empty strings and -1 stand for "not set" (PostgreSQL NULL); report them as ''.
    return ((await rs.json()) as { key: string; value: number | null; count: number }[]).map((r) => ({
      ...r,
      key: r.key === '-1' || (q.groupBy === 'guild' && r.key === '0') ? '' : r.key,
    }));
  }

  /** Hour × weekday counts, or `undefined` if ClickHouse can't answer it. */
  async heatmap(
    appId: string,
    q: AnalyticsQuery & { timezone: string },
    encode: (field: string, value: string) => string,
  ): Promise<{ weekday: number; hour: number; value: number }[] | undefined> {
    const target = this.#target({ ...q, stat: 'count' });
    if (!target) return undefined;
    const params = this.#params(q, { app: appId, tz: q.timezone });
    const where = this.#filters(target, this.#encoded(q.filters, encode), params);
    const rs = await this.#client.query({
      query: `SELECT toDayOfWeek(bucket, 0, {tz:String}) AS weekday, toHour(bucket, {tz:String}) AS hour,
                     toFloat64(sumMerge(runs)) AS value
                FROM ${target.table}
               WHERE app_id = {app:UInt64} AND bucket >= toDateTime({from:UInt32}) AND bucket < toDateTime({to:UInt32})${target.where}${where}
               GROUP BY weekday, hour ORDER BY weekday, hour`,
      query_params: params,
      format: 'JSONEachRow',
    });
    return (await rs.json()) as { weekday: number; hour: number; value: number }[];
  }

  #encoded(filters: readonly Filter[], encode: (field: string, value: string) => string): Filter[] {
    return filters.map((f) => ({
      ...f,
      value: Array.isArray(f.value) ? f.value.map((v) => encode(f.field, v)) : encode(f.field, f.value),
    }));
  }
}
