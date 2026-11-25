import { BUCKETS } from '@shardlens/core';
import type { Collection, Document } from 'mongodb';
import { encodeValue } from '../../../query/dimensions.js';
import type { Filter } from '../../../query/spec.js';
import type { RollupDoc } from '../collections.js';
import type { Mongo } from '../connect.js';
import { POSTGRES_BUCKET_UPPER_MS } from '../histogram.js';

const DAY = 86_400_000;
const BUCKET_MS = { minute: 60_000, hour: 3_600_000, day: DAY } as const;

/**
 * The rollups to read for a range, and where reading starts, as PostgreSQL's `rollupSource`
 * (`postgres/query/rollup-source.ts`) picks them: hourly ones for 13 months, daily ones beyond, minutes only when asked
 * for, read from the start of the bucket `from` falls in.
 */
export function rollupSource(
  m: Mongo,
  from: Date,
  now: Date,
  minutes = false,
): { grain: keyof typeof BUCKET_MS; rollups: Collection<RollupDoc>; from: Date } {
  const grain = minutes ? 'minute' : now.getTime() - from.getTime() <= 395 * DAY ? 'hour' : 'day';
  const size = BUCKET_MS[grain];
  const rollups = grain === 'minute' ? m.c.rollup1m : grain === 'hour' ? m.c.rollup1h : m.c.rollup1d;
  return { grain, rollups, from: new Date(Math.floor(from.getTime() / size) * size) };
}

/**
 * `dims->>field`: a dimension as text, `null` when the rollup has none. Codes, `true` and `false` print as `jsonb`
 * prints them. `field` is one of the spec's dimensions, never free text.
 */
export const dim = (field: string): Document => ({ $toString: `$dims.${field}` });

/** `coalesce(dims->>field, '')`, the key rollups are grouped under. */
export const dimKey = (field: string): Document => ({ $ifNull: [dim(field), ''] });

/** PostgreSQL's `filterSql`: every filter's dimension equal to one of its values, as stored codes. */
export function dimFilters(filters: readonly Filter[]): Document {
  if (filters.length === 0) return {};
  return {
    $expr: {
      $and: filters.map((f) => ({
        $in: [
          dim(f.field),
          { $literal: (Array.isArray(f.value) ? f.value : [f.value]).map((v) => encodeValue(f.field, v)) },
        ],
      })),
    },
  };
}

const HIST_FIELDS = Array.from({ length: BUCKETS }, (_, i) => `h${i}`);

/**
 * `$group` accumulators for `shardlens_hist_sum(hist)` of rollups, one sum per latency bucket (`h0` to `h39`): unlike
 * collecting the histograms, they hold nothing per document. A group without histograms sums to zeros, which the
 * quantile reads as PostgreSQL reads a `NULL` histogram.
 */
export const HIST_SUMS: Document = Object.fromEntries(
  HIST_FIELDS.map((f, i) => [f, { $sum: { $arrayElemAt: ['$hist', i] } }]),
);

/** As {@link HIST_SUMS}, adding up groups that have them. */
export const HIST_RESUMS: Document = Object.fromEntries(HIST_FIELDS.map((f) => [f, { $sum: `$${f}` }]));

/** The histogram of a group with {@link HIST_SUMS}, as one array. */
export const HIST_ARRAY: readonly string[] = HIST_FIELDS.map((f) => `$${f}`);

/**
 * `shardlens_hist_quantile(hist, q)` in a pipeline: the upper bound of the first bucket where the cumulative share
 * reaches `q`, `null` for an empty histogram. The bounds are PostgreSQL's own (`histogram.ts`), so values are equal.
 */
export function histQuantile(hist: unknown, q: number): Document {
  const step = {
    $cond: [
      { $ne: ['$$value.i', null] },
      '$$value',
      {
        $let: {
          vars: { c: { $add: ['$$value.c', { $ifNull: [{ $arrayElemAt: ['$$h', '$$this'] }, 0] }] } },
          in: {
            c: '$$c',
            i: {
              $cond: [{ $and: [{ $gt: ['$$c', 0] }, { $gte: [{ $divide: ['$$c', '$$total'] }, q] }] }, '$$this', null],
            },
          },
        },
      },
    ],
  };
  return {
    $let: {
      vars: { h: hist },
      in: {
        $let: {
          vars: { total: { $sum: '$$h' } },
          in: {
            $cond: [
              { $gt: ['$$total', 0] },
              {
                $let: {
                  vars: {
                    found: { $reduce: { input: { $range: [0, BUCKETS] }, initialValue: { c: 0, i: null }, in: step } },
                  },
                  in: {
                    $cond: [
                      { $eq: ['$$found.i', null] },
                      null,
                      { $arrayElemAt: [{ $literal: POSTGRES_BUCKET_UPPER_MS }, '$$found.i'] },
                    ],
                  },
                },
              },
              null,
            ],
          },
        },
      },
    },
  };
}

const QUANTILE = { p50: 0.5, p95: 0.95, p99: 0.99 } as const;

/**
 * A `stat` of a group with `count`, `sum` and {@link HIST_SUMS}, as PostgreSQL's `STAT_SQL` computes it:
 * `sum(count)`, `sum(sum)`, `sum(sum) / nullif(sum(count), 0)` or a histogram quantile.
 */
export function statValue(stat: 'count' | 'sum' | 'avg' | 'p50' | 'p95' | 'p99'): Document | string {
  switch (stat) {
    case 'count':
      return '$count';
    case 'sum':
      return '$sum';
    case 'avg':
      return { $cond: [{ $eq: ['$count', 0] }, null, { $divide: ['$sum', '$count'] }] };
    default:
      return histQuantile([...HIST_ARRAY], QUANTILE[stat]);
  }
}

/** Whether a stat reads the histograms, so groups that don't need them skip their 40 sums. */
export const readsHistogram = (stat: string): boolean => stat in QUANTILE;
