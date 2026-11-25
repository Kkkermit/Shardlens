import { BUCKETS, bucketOf } from '@shardlens/core';
import type { AggregationCursor, Document } from 'mongodb';
import { COMMAND_KINDS, KIND } from '../../ingest/codes.js';
import type { Collections, RollupDoc } from './collections.js';

export type Grain = 'minute' | 'hour' | 'day';

/** One group a source returns: the figures of the single events with these dimensions in one bucket. */
export interface SourceRow {
  _id: {
    a: string;
    t: Date;
    m: string;
    d: RollupDoc['dims'];
    /** Latency bucket of these events' `ackMs`, `null` when they have none (latency sources only). */
    b?: number | null;
    /** The events' weight, in metrics that add weights up: `count` is then the number of events. */
    w?: number;
    /** What each of those events counts for before its weight (REST calls: the calls it stands for). */
    x?: number;
  };
  count: number;
  sum: number;
  min?: number | null;
  max?: number | null;
  /** The events' weights, rounded one by one as PostgreSQL's histograms round them (latency sources only). */
  hw?: number;
  /** The events' own histograms, added up (REST calls). */
  hist?: number[] | null;
}

interface Aggregatable {
  aggregate<T extends Document>(pipeline: Document[]): AggregationCursor<T>;
}

/** One of PostgreSQL's `MINUTE_SOURCES` (`postgres/rollups.ts`): a metric family cut from one kind of single event. */
interface RollupSource {
  /** For `skipped`. */
  name: string;
  /** The metrics its documents carry: what recomputing a bucket replaces. */
  metrics: (string | RegExp)[];
  from(c: Collections): Aggregatable;
  pipeline(apps: string[], from: Date, to: Date, grain: Grain): Document[];
}

/** `ackMs` values where each latency bucket after the first starts: the smallest whole ms `bucketOf` puts in it. */
const ACK_THRESHOLDS: number[] = [];
for (let ms = 0; ACK_THRESHOLDS.length < BUCKETS - 1; ms++) {
  while (ACK_THRESHOLDS.length < BUCKETS - 1 && bucketOf(ms) > ACK_THRESHOLDS.length) ACK_THRESHOLDS.push(ms);
}

/**
 * `bucketOf(ackMs)` in a pipeline, exactly: `ackMs` is a whole number of ms, and `bucketOf` never goes down as the ms
 * go up, so the bucket is the number of thresholds reached. Computing the logarithm on the server instead could round
 * across a bucket boundary.
 */
const ACK_BUCKET = {
  $cond: [
    { $eq: [{ $ifNull: ['$ackMs', null] }, null] },
    null,
    { $size: { $filter: { input: ACK_THRESHOLDS, cond: { $lte: ['$$this', '$ackMs'] } } } },
  ],
};

const orNull = (expr: unknown) => ({ $ifNull: [expr, null] });
const truncate = (field: string, grain: Grain) => ({ $dateTrunc: { date: field, unit: grain } });
const inWindow = (apps: string[], from: Date, to: Date) => ({ appId: { $in: apps }, ts: { $gte: from, $lt: to } });

/** Element-wise sum of the histograms in an array (missing ones are not pushed), `null` when there are none. */
export function sumHistograms(list: unknown): Document {
  const at = (array: string, i: string) => ({ $ifNull: [{ $arrayElemAt: [array, i] }, 0] });
  return {
    $reduce: {
      input: list,
      initialValue: null,
      in: {
        $cond: [
          { $eq: ['$$value', null] },
          '$$this',
          {
            $map: {
              input: { $range: [0, { $max: [{ $size: '$$value' }, { $size: '$$this' }] }] },
              as: 'i',
              in: { $add: [at('$$value', '$$i'), at('$$this', '$$i')] },
            },
          },
        ],
      },
    },
  };
}

/** A group of `SourceRow`: the metric's events of one app, bucket and set of dimensions. */
const plain = (metric: string, dims: Document) => (grain: Grain) => ({
  a: '$appId',
  t: truncate('$ts', grain),
  m: { $literal: metric },
  d: dims,
});

/*
 * PostgreSQL adds weights up as `real` (`query/real-sums.ts`), so the sources that add them group events by weight as
 * well, and `rollups.ts` adds the weights up from the counts. Sums of latency stay in double precision, as do counts of
 * unweighted events.
 */

/** A metric of interactions with their first-response latency: count by weight, ack time summed, its histogram. */
function latency(name: string, where: Document, dims: Document): RollupSource {
  return {
    name,
    metrics: [name],
    from: (c) => c.interactions,
    pipeline: (apps, from, to, grain) => [
      { $match: { ...inWindow(apps, from, to), ...where } },
      {
        $group: {
          _id: { ...plain(name, dims)(grain), b: ACK_BUCKET, w: '$weight' },
          count: { $sum: 1 },
          sum: { $sum: { $multiply: [{ $ifNull: ['$ackMs', 0] }, '$weight'] } },
          min: { $min: '$ackMs' },
          max: { $max: '$ackMs' },
          hw: { $sum: { $round: ['$weight', 0] } },
        },
      },
    ],
  };
}

/** A metric that counts events (or adds up their weights) and nothing else. */
function counter(
  name: string,
  metrics: (string | RegExp)[],
  from: (c: Collections) => Aggregatable,
  id: (grain: Grain) => Document,
  weighted = false,
): RollupSource {
  return {
    name,
    metrics,
    from,
    pipeline: (apps, start, end, grain) => [
      { $match: inWindow(apps, start, end) },
      {
        $group: {
          _id: weighted ? { ...id(grain), w: '$weight' } : id(grain),
          count: { $sum: 1 },
          sum: { $sum: 0 },
        },
      },
    ],
  };
}

/** Every metric the rollup job keeps, in PostgreSQL's order. */
export const ROLLUP_SOURCES: readonly RollupSource[] = [
  // No server dimension here, so the collection doesn't grow with commands × servers; per-server numbers come from
  // `interactions.by_guild`.
  latency(
    'interactions',
    { kind: { $in: COMMAND_KINDS } },
    {
      kind: '$kind',
      command: orNull('$command'),
      sub: orNull('$sub'),
      outcome: '$outcome',
      context: orNull('$context'),
      install: orNull('$install'),
      locale: '$locale',
      tier: orNull('$memberTier'),
    },
  ),
  latency(
    'interactions.by_guild',
    { kind: { $in: COMMAND_KINDS }, guildId: { $exists: true } },
    { kind: '$kind', command: orNull('$command'), outcome: '$outcome', guild: '$guildId' },
  ),
  latency(
    'interactions.autocomplete',
    { kind: KIND.autocomplete },
    { command: orNull('$command'), option: orNull({ $arrayElemAt: ['$options', 0] }) },
  ),
  latency(
    'components',
    { kind: { $in: [KIND.button, KIND.select] } },
    {
      kind: '$kind',
      custom_id: orNull('$customId'),
      source: orNull('$sourceCommand'),
      outcome: '$outcome',
      guild: orNull('$guildId'),
    },
  ),
  latency('modals.submitted', { kind: KIND.modal_submit }, { custom_id: orNull('$customId'), outcome: '$outcome' }),
  {
    name: 'modals.shown',
    metrics: ['modals.shown'],
    from: (c) => c.interactions,
    pipeline: (apps, from, to, grain) => [
      { $match: { ...inWindow(apps, from, to), responseType: 9 } },
      {
        $group: {
          _id: {
            ...plain('modals.shown', {
              command: { $ifNull: ['$command', '$sourceCommand', null] },
              custom_id: orNull('$customId'),
            })(grain),
            w: '$weight',
          },
          count: { $sum: 1 },
          sum: { $sum: 0 },
        },
      },
    ],
  },
  {
    name: 'interactions.errors',
    metrics: ['interactions.errors'],
    from: (c) => c.interactionErrors,
    pipeline: (apps, from, to, grain) => [
      { $match: inWindow(apps, from, to) },
      {
        $group: {
          _id: {
            ...plain('interactions.errors', { command: orNull('$command'), error_class: '$errorClass' })(grain),
            w: '$weight',
          },
          count: { $sum: 1 },
          sum: { $sum: { $multiply: [{ $ifNull: ['$handlerMs', 0] }, '$weight'] } },
          min: { $min: '$handlerMs' },
          max: { $max: '$handlerMs' },
        },
      },
    ],
  },
  {
    name: 'rest.calls',
    metrics: ['rest.calls'],
    from: (c) => c.restCalls,
    pipeline: (apps, from, to, grain) => [
      { $match: inWindow(apps, from, to) },
      {
        $group: {
          _id: {
            ...plain('rest.calls', { method: '$method', route: '$route', status: '$status' })(grain),
            w: '$weight',
            x: '$count',
          },
          count: { $sum: 1 },
          sum: { $sum: { $multiply: ['$retries', '$weight'] } },
          hists: { $push: '$hist' },
        },
      },
      { $project: { count: 1, sum: 1, hist: sumHistograms('$hists') } },
    ],
  },
  {
    name: 'rest.invalid',
    metrics: ['rest.invalid'],
    from: (c) => c.restInvalid,
    pipeline: (apps, from, to, grain) => [
      { $match: inWindow(apps, from, to) },
      {
        $project: {
          appId: 1,
          ts: 1,
          s: [
            { status: '401', n: '$count401' },
            { status: '403', n: '$count403' },
            { status: '429', n: '$count429' },
            { status: '429_shared', n: '$shared429' },
          ],
        },
      },
      { $unwind: '$s' },
      {
        $group: {
          _id: plain('rest.invalid', { status: '$s.status' })(grain),
          count: { $sum: '$s.n' },
          sum: { $sum: 0 },
        },
      },
    ],
  },
  {
    name: 'rest.ratelimits',
    metrics: ['rest.ratelimits'],
    from: (c) => c.rateLimits,
    pipeline: (apps, from, to, grain) => [
      { $match: inWindow(apps, from, to) },
      {
        $group: {
          _id: plain('rest.ratelimits', { scope: '$scope', route: '$route' })(grain),
          count: { $sum: 1 },
          sum: { $sum: '$retryAfter' },
          min: { $min: '$retryAfter' },
          max: { $max: '$retryAfter' },
        },
      },
    ],
  },
  {
    name: 'guild events',
    metrics: ['guild.joins', 'guild.leaves', 'guild.unavailable'],
    from: (c) => c.guildEvents,
    pipeline: (apps, from, to, grain) => [
      { $match: { '_id.appId': { $in: apps }, '_id.ts': { $gte: from, $lt: to }, '_id.kind': { $in: [1, 2, 3] } } },
      {
        $group: {
          _id: {
            a: '$_id.appId',
            t: truncate('$_id.ts', grain),
            m: { $arrayElemAt: [['', 'guild.joins', 'guild.leaves', 'guild.unavailable'], '$_id.kind'] },
            d: { detected: '$detectedAtStartup' },
          },
          count: { $sum: 1 },
          sum: { $sum: 0 },
        },
      },
    ],
  },
  counter(
    'webhook events',
    [/^webhook\./],
    (c) => c.webhookEvents,
    (grain) => ({
      a: '$appId',
      t: truncate('$ts', grain),
      m: { $concat: ['webhook.', { $toLower: '$type' }] },
      d: { integration_type: orNull('$integrationType') },
    }),
  ),
  counter(
    'entitlements',
    ['entitlements'],
    (c) => c.entitlements,
    plain('entitlements', { action: '$action', sku: '$skuId', source: '$source' }),
  ),
  counter(
    'subscriptions',
    ['subscriptions'],
    (c) => c.subscriptions,
    plain('subscriptions', { action: '$action', status: '$status' }),
  ),
  counter(
    'custom events',
    [/^custom\./],
    (c) => c.customEvents,
    (grain) => ({ a: '$appId', t: truncate('$ts', grain), m: { $concat: ['custom.', '$name'] }, d: { $literal: {} } }),
    true,
  ),
];
