import type { ClickHouseStore } from '../storage/clickhouse.js';
import type { QueryAnswer, SeriesRow, Store } from '../storage/store.js';
import { decodeValue, encodeValue, resolveMetric } from './dimensions.js';
import { QueryError } from './error.js';
import { withGuildNames } from './guild-names.js';
import type { QuerySpec, Spec } from './spec.js';

const DAY = 86_400_000;

async function series(
  store: Store,
  appId: string,
  spec: Spec<'series'>,
  now: Date,
  analytics?: ClickHouseStore,
): Promise<QueryAnswer<'series'>> {
  const asked = new Date(spec.range.from);
  const to = new Date(spec.range.to);
  const span = to.getTime() - asked.getTime();
  if (spec.interval === 'minute' && span > 2 * DAY) throw new QueryError('minute series are limited to 2 days');
  if (spec.interval === 'hour' && span > 31 * DAY) throw new QueryError('hourly series are limited to 31 days');
  const metric = resolveMetric(spec);
  const point = (r: SeriesRow) => ({
    t: r.t,
    key: spec.groupBy ? decodeValue(spec.groupBy, r.key) : null,
    value: r.value,
  });
  // ClickHouse keeps minutes and widens the range to the minute itself, so it gets the range as asked.
  const fromAnalytics = await analytics?.series(appId, { ...spec, metric, from: asked, to }, encodeValue);
  if (fromAnalytics) return { timezone: spec.timezone, source: 'clickhouse', points: fromAnalytics.map(point) };
  return { timezone: spec.timezone, points: (await store.query.series(appId, spec, metric, now)).map(point) };
}

async function top(
  store: Store,
  appId: string,
  spec: Spec<'top'>,
  now: Date,
  analytics?: ClickHouseStore,
): Promise<QueryAnswer<'top'>> {
  const asked = new Date(spec.range.from);
  const to = new Date(spec.range.to);
  const metric = resolveMetric(spec);
  const fromAnalytics = await analytics?.top(appId, { ...spec, metric, from: asked, to }, encodeValue);
  const raw = fromAnalytics ?? (await store.query.top(appId, spec, metric, now));
  const rows = raw.map((r) => ({ key: decodeValue(spec.groupBy, r.key) ?? '', value: r.value, count: r.count }));
  if (spec.groupBy !== 'guild') return { rows };
  return { rows: await withGuildNames((app, ids) => store.query.guildNames(app, ids), appId, rows) };
}

async function heatmap(
  store: Store,
  appId: string,
  spec: Spec<'heatmap'>,
  now: Date,
  analytics?: ClickHouseStore,
): Promise<QueryAnswer<'heatmap'>> {
  const asked = new Date(spec.range.from);
  const to = new Date(spec.range.to);
  const metric = resolveMetric(spec);
  const fromAnalytics = await analytics?.heatmap(appId, { ...spec, metric, from: asked, to }, encodeValue);
  if (fromAnalytics) return { timezone: spec.timezone, source: 'clickhouse', cells: fromAnalytics };
  return { timezone: spec.timezone, cells: await store.query.heatmap(appId, spec, metric, now) };
}

/**
 * Runs a typed query. With a ClickHouse analytics store, the generic chart kinds (series, top, heatmap) for
 * interactions and custom events are answered from ClickHouse when it covers the whole range; anything else, and any
 * range starting before ClickHouse was enabled, is answered by the store.
 */
export async function runQuery(
  store: Store,
  appId: string,
  spec: QuerySpec,
  now = new Date(),
  analytics?: ClickHouseStore,
): Promise<QueryAnswer<QuerySpec['kind']>> {
  const q = store.query;
  switch (spec.kind) {
    case 'series':
      return series(store, appId, spec, now, analytics);
    case 'top':
      return top(store, appId, spec, now, analytics);
    case 'heatmap':
      return heatmap(store, appId, spec, now, analytics);
    case 'commands':
      return q.commands(appId, spec, now);
    case 'command':
      return q.command(appId, spec, now);
    case 'servers':
      return q.servers(appId, spec, now);
    case 'server':
      return q.server(appId, spec, now);
    case 'growth':
      return q.growth(appId, spec, now);
    case 'audience':
      return q.audience(appId, spec, now);
    case 'overview':
      return q.overview(appId, spec, now);
    case 'gauge':
      return q.gauge(appId, spec, now);
    case 'bursts':
      return q.bursts(appId, spec, now);
    case 'reliability':
      return q.reliability(appId, spec, now);
    case 'premium':
      return q.premium(appId, spec, now);
    case 'events':
      return q.events(appId, spec, now);
    case 'eventProps':
      return q.eventProps(appId, spec, now);
    case 'funnel':
      return q.funnel(appId, spec, now);
    case 'retention':
      return q.retention(appId, spec, now);
    case 'installs':
      return q.installs(appId, spec, now);
  }
}
