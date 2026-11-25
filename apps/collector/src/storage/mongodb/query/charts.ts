import type { Document } from 'mongodb';
import type { Filter, Spec } from '../../../query/spec.js';
import type { HeatmapCell, QueryStorage, SeriesRow, TopRow } from '../../store.js';
import type { Mongo } from '../connect.js';
import { byteOrder } from './pg-values.js';
import { dimFilters, dimKey, HIST_RESUMS, HIST_SUMS, readsHistogram, rollupSource, statValue } from './rollup-reads.js';
import { clockText, truncWall, wallClock } from './zoned-buckets.js';

/*
 * The generic charts from rollups, as `postgres/query/pages.ts` answers them: the same rollups, buckets, keys and
 * figures. Each is one aggregation. Rollups are first added up per stored bucket, so the time zone is worked out once
 * per bucket rather than once per document.
 */

const DAY = 86_400_000;

function matchRollups(appId: string, metric: string, from: Date, to: Date, filters: readonly Filter[]) {
  return { $match: { appId, metric, bucket: { $gte: from, $lt: to }, ...dimFilters(filters) } };
}

/** Rollups added up: `count`, `sum` and, for a quantile, the histogram. */
const rollupSums = (stat: string): Document => ({
  count: { $sum: '$count' },
  sum: { $sum: '$sum' },
  ...(readsHistogram(stat) ? HIST_SUMS : {}),
});

/** Groups made with {@link rollupSums} added up. */
const groupSums = (stat: string): Document => ({
  count: { $sum: '$count' },
  sum: { $sum: '$sum' },
  ...(readsHistogram(stat) ? HIST_RESUMS : {}),
});

async function series(m: Mongo, appId: string, spec: Spec<'series'>, metric: string, now: Date): Promise<SeriesRow[]> {
  const { grain, rollups, from } = rollupSource(m, new Date(spec.range.from), now, spec.interval === 'minute');
  // Hourly buckets start on UTC hours, which in India fall at half past: they keep their real start (10:30) instead of
  // going under the hour before. Daily buckets, all that is kept after 13 months, are UTC days and keep their date.
  const unit = grain === 'day' ? spec.interval : spec.interval === 'hour' ? 'minute' : spec.interval;
  const wall = grain === 'day' ? '$_id.b' : wallClock('$_id.b', spec.timezone);
  const rows = await rollups
    .aggregate<{ t: string; key: string; value: number | null }>([
      matchRollups(appId, metric, from, new Date(spec.range.to), spec.filters),
      {
        $group: {
          _id: { b: '$bucket', k: spec.groupBy ? dimKey(spec.groupBy) : { $literal: '' } },
          ...rollupSums(spec.stat),
        },
      },
      {
        $group: {
          _id: { t: clockText(truncWall(wall, unit)), k: '$_id.k' },
          ...groupSums(spec.stat),
        },
      },
      { $project: { count: 1, point: { t: '$_id.t', value: statValue(spec.stat) } } },
      // The `limit` keys with the most events over the whole range.
      { $group: { _id: '$_id.k', total: { $sum: '$count' }, points: { $push: '$point' } } },
      { $sort: { total: -1, _id: 1 } },
      { $limit: spec.limit },
      { $unwind: '$points' },
      { $project: { _id: 0, t: '$points.t', key: '$_id', value: '$points.value' } },
    ])
    .toArray();
  // PostgreSQL orders points by time only; keys of one time come in key order here.
  return rows.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : byteOrder(a.key, b.key)));
}

async function top(m: Mongo, appId: string, spec: Spec<'top'>, metric: string, now: Date): Promise<TopRow[]> {
  const { rollups, from } = rollupSource(m, new Date(spec.range.from), now);
  return rollups
    .aggregate<TopRow>([
      matchRollups(appId, metric, from, new Date(spec.range.to), spec.filters),
      { $group: { _id: dimKey(spec.groupBy), ...rollupSums(spec.stat) } },
      { $project: { _id: 0, key: '$_id', value: statValue(spec.stat), count: 1 } },
      // Descending puts `null` last, as `NULLS LAST` does. Ties, which PostgreSQL leaves in any order, go by key.
      { $sort: { value: -1, key: 1 } },
      { $limit: spec.limit },
    ])
    .toArray();
}

async function heatmap(
  m: Mongo,
  appId: string,
  spec: Spec<'heatmap'>,
  metric: string,
  now: Date,
): Promise<HeatmapCell[]> {
  // Hours of the day need hourly buckets: they cover 13 months, and daily ones would put everything at midnight.
  const asked = new Date(spec.range.from);
  const { rollups, from } = rollupSource(m, new Date(Math.max(asked.getTime(), now.getTime() - 395 * DAY)), now);
  const timezone = { $literal: spec.timezone };
  return rollups
    .aggregate<HeatmapCell>([
      matchRollups(appId, metric, from, new Date(spec.range.to), spec.filters),
      { $group: { _id: '$bucket', value: { $sum: '$count' } } },
      {
        $group: {
          _id: {
            weekday: { $isoDayOfWeek: { date: '$_id', timezone } },
            hour: { $hour: { date: '$_id', timezone } },
          },
          value: { $sum: '$value' },
        },
      },
      { $sort: { '_id.weekday': 1, '_id.hour': 1 } },
      { $project: { _id: 0, weekday: '$_id.weekday', hour: '$_id.hour', value: 1 } },
    ])
    .toArray();
}

export function mongoChartsQueries(m: Mongo): Pick<QueryStorage, 'series' | 'top' | 'heatmap'> {
  return {
    series: (appId, spec, metric, now) => series(m, appId, spec, metric, now),
    top: (appId, spec, metric, now) => top(m, appId, spec, metric, now),
    heatmap: (appId, spec, metric, now) => heatmap(m, appId, spec, metric, now),
  };
}
