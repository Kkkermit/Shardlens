import type { Document } from 'mongodb';
import { KIND } from '../../../ingest/codes.js';
import { QueryError } from '../../../query/error.js';
import type { Spec } from '../../../query/spec.js';
import type { QueryAnswer, QueryStorage } from '../../store.js';
import type { Mongo } from '../connect.js';
import { ACK_WEIGHTS, ackQuantile } from '../histogram.js';
import { sumHistograms } from '../rollup-sources.js';
import { histQuantile } from './bucket-quantile.js';
import { rawFrom, rollupSource } from './read-window.js';
import { realRatio, realSum, type WeightRows } from './real-sums.js';
import { sdkInstances } from './sdk-instances.js';
import { offsetPieces, wallClock } from './wall-clock.js';

const MINUTE = 60_000;
const DAY = 86_400_000;

/** Gauges that count something each shard or process holds, so the bot's figure is their sum. Others are averaged. */
const ADDITIVE_GAUGES = new Set([
  'shard.guilds',
  'memory.rss_bytes',
  'memory.heap_used_bytes',
  'cache.users',
  'cache.channels',
]);
/** Process gauges the reliability page shows: added up over processes, but for event-loop delay, the worst. */
const PROCESS_GAUGES = [
  'eventloop.p99_ms',
  'memory.rss_bytes',
  'memory.heap_used_bytes',
  'cache.users',
  'cache.channels',
];

type Reliability = QueryAnswer<'reliability'>;

/**
 * The slot a gauge sample fills, named as `postgres/query/gauge-samples.ts` names it: its shard, or for a process-wide
 * sample the shards its process last reported holding, or the process alone when it holds none. One process per slot
 * is kept in each minute, and slots are added up in the order of their names.
 */
function slotOf(shard: unknown, shards: unknown, instance: unknown): Document {
  const listed = {
    $reduce: {
      input: shards,
      initialValue: '',
      in: { $concat: ['$$value', { $cond: [{ $eq: ['$$value', ''] }, '', ','] }, { $toString: '$$this' }] },
    },
  };
  return {
    $cond: [
      { $gte: [shard, 0] },
      { $concat: ['shard ', { $toString: shard }] },
      {
        $cond: [
          { $gt: [{ $size: shards }, 0] },
          { $concat: ['shards ', listed] },
          { $concat: ['instance ', instance] },
        ],
      },
    ],
  };
}

/**
 * `field` of `list`'s documents added up one after another in order, as PostgreSQL's `sum` and `avg` of a `float8` add
 * the rows they are given: `$sum` and `$avg` add with extra precision, which can differ in the last digit.
 */
function addedInOrder(list: unknown, field: string): Document {
  return { $reduce: { input: list, initialValue: 0, in: { $add: ['$$value', `$$this.${field}`] } } };
}

/** Pipeline stages that put the process's last health report into `field` (an `_id` to look up, `{ appId, instance }`). */
function healthOf(m: Mongo, field: string): Document[] {
  return [
    {
      $lookup: {
        from: m.c.sdkHealth.collectionName,
        localField: field,
        foreignField: '_id',
        as: field,
        pipeline: [{ $project: { shards: 1 } }],
      },
    },
    { $set: { [field]: { $ifNull: [{ $first: `$${field}.shards` }, []] } } },
  ];
}

async function gauge(m: Mongo, appId: string, spec: Spec<'gauge'>): Promise<QueryAnswer<'gauge'>> {
  const from = new Date(spec.range.from);
  const to = new Date(spec.range.to);
  if (spec.interval === 'minute' && to.getTime() - from.getTime() > 2 * DAY) {
    throw new QueryError('minute series are limited to 2 days');
  }
  // Every shard and process reports its own samples. They are combined minute by minute (added up, or averaged for
  // a latency) before the minutes are averaged into the interval, keeping one process per slot in each minute.
  const additive = ADDITIVE_GAUGES.has(spec.name);
  const pieces = offsetPieces(spec.timezone, from.getTime(), to.getTime());
  const samples = (shard: Document) => ({
    $match: { '_id.appId': appId, '_id.name': spec.name, '_id.ts': { $gte: from, $lt: to }, '_id.shard': shard },
  });
  const perSource = {
    $group: {
      _id: { m: { $dateTrunc: { date: '$_id.ts', unit: 'minute' } }, s: '$_id.shard', i: '$_id.instance' },
      v: { $avg: '$value' },
      mx: { $max: '$value' },
      last: { $max: '$_id.ts' },
    },
  };
  const points = await m.c.gauges
    .aggregate<{ _id: { t: string; s: number | null }; value: number; max: number }>([
      samples({ $gte: 0 }),
      perSource,
      { $set: { slot: { s: '$_id.s' } } },
      {
        // Process-wide samples need their process's shards: looked up once per process rather than once per minute.
        $unionWith: {
          coll: m.c.gauges.collectionName,
          pipeline: [
            samples({ $lt: 0 }),
            perSource,
            {
              $group: {
                _id: '$_id.i',
                minutes: { $push: { m: '$_id.m', s: '$_id.s', v: '$v', mx: '$mx', last: '$last' } },
              },
            },
            { $set: { health: { appId: { $literal: appId }, instance: '$_id' } } },
            ...healthOf(m, 'health'),
            { $unwind: '$minutes' },
            {
              $replaceWith: {
                _id: { m: '$minutes.m', s: '$minutes.s', i: '$_id' },
                v: '$minutes.v',
                mx: '$minutes.mx',
                last: '$minutes.last',
                slot: slotOf('$minutes.s', '$health', '$_id'),
              },
            },
          ],
        },
      },
      {
        $group: {
          _id: { m: '$_id.m', slot: '$slot' },
          source: { $top: { sortBy: { last: -1, '_id.i': 1 }, output: { s: '$_id.s', v: '$v', mx: '$mx' } } },
        },
      },
      // PostgreSQL combines a minute's slots in the order of their names, and averages the interval's minutes in the
      // order they came: added the same way, the answers agree to the last digit.
      {
        $group: {
          _id: { m: '$_id.m', s: spec.perShard ? '$source.s' : null },
          slots: { $push: { slot: '$_id.slot', v: '$source.v', mx: '$source.mx' } },
        },
      },
      { $set: { slots: { $sortArray: { input: '$slots', sortBy: { slot: 1 } } } } },
      {
        $set: {
          v: additive ? addedInOrder('$slots', 'v') : { $divide: [addedInOrder('$slots', 'v'), { $size: '$slots' }] },
          mx: additive ? addedInOrder('$slots', 'mx') : { $max: '$slots.mx' },
        },
      },
      {
        $group: {
          _id: {
            t: {
              $dateToString: {
                date: { $dateTrunc: { date: wallClock('$_id.m', pieces), unit: spec.interval } },
                format: '%Y-%m-%dT%H:%M:%S',
              },
            },
            s: '$_id.s',
          },
          minutes: { $push: { m: '$_id.m', v: '$v' } },
          max: { $max: '$mx' },
        },
      },
      {
        $project: {
          max: 1,
          value: {
            $divide: [
              addedInOrder({ $sortArray: { input: '$minutes', sortBy: { m: 1 } } }, 'v'),
              { $size: '$minutes' },
            ],
          },
        },
      },
      { $sort: { '_id.t': 1, '_id.s': 1 } },
      { $limit: 20_000 },
    ])
    .toArray();
  return {
    timezone: spec.timezone,
    points: points.map((p) => ({ t: p._id.t, shard: p._id.s, value: p.value, max: p.max })),
  };
}

async function bursts(m: Mongo, appId: string, spec: Spec<'bursts'>, now: Date): Promise<QueryAnswer<'bursts'>> {
  const from = new Date(Math.max(Date.parse(spec.range.from), now.getTime() - 14 * DAY));
  // The median minute is PostgreSQL's `percentile_cont(0.5)`: exact, halfway between the middle two when they are an
  // even number, worked out on the server so only the busiest minutes come back.
  const [result] = await m.c.rollup1m
    .aggregate<{ median: number; rows: { minute: Date; runs: number }[] }>([
      { $match: { appId, metric: 'interactions', bucket: { $gte: from, $lt: new Date(spec.range.to) } } },
      { $group: { _id: '$bucket', n: { $sum: '$count' } } },
      { $group: { _id: null, minutes: { $push: { minute: '$_id', runs: '$n' } } } },
      { $set: { sorted: { $sortArray: { input: '$minutes.runs', sortBy: 1 } } } },
      { $set: { pos: { $multiply: [0.5, { $subtract: [{ $size: '$sorted' }, 1] }] } } },
      {
        $set: {
          lo: { $arrayElemAt: ['$sorted', { $toInt: { $floor: '$pos' } }] },
          hi: { $arrayElemAt: ['$sorted', { $toInt: { $ceil: '$pos' } }] },
          frac: { $subtract: ['$pos', { $floor: '$pos' }] },
        },
      },
      {
        $set: {
          median: {
            $cond: [
              { $eq: ['$frac', 0] },
              '$lo',
              { $add: ['$lo', { $multiply: ['$frac', { $subtract: ['$hi', '$lo'] }] }] },
            ],
          },
        },
      },
      {
        $project: {
          _id: 0,
          median: 1,
          rows: {
            $cond: [
              { $gt: ['$median', 0] },
              {
                $slice: [
                  {
                    $sortArray: {
                      input: {
                        $filter: {
                          input: '$minutes',
                          cond: { $gt: ['$$this.runs', { $multiply: ['$median', spec.factor] }] },
                        },
                      },
                      sortBy: { runs: -1, minute: 1 },
                    },
                  },
                  100,
                ],
              },
              [],
            ],
          },
        },
      },
    ])
    .toArray();
  return { rows: (result?.rows ?? []).map((r) => ({ minute: r.minute, runs: r.runs, median: result!.median })) };
}

/** Interactions by weight and what the totals count, for PostgreSQL's float4 sums of weights (`real-sums.ts`). */
interface RunGroup {
  _id: { w: number; outcome: number; slow: boolean; acked: boolean };
  n: number;
}

function runTotals(groups: readonly RunGroup[], ack: readonly { _id: number; w: number }[]): Reliability['totals'] {
  const weights = (keep: (k: RunGroup['_id']) => boolean): WeightRows[] =>
    groups.filter((g) => keep(g._id)).map((g) => ({ w: g._id.w, n: g.n }));
  const ran = groups.some((g) => g.n > 0);
  // `countWhenRan`: 0 when none matched, `null` only when nothing ran.
  const counted = (keep: (k: RunGroup['_id']) => boolean) => (ran ? (realSum(weights(keep)) ?? 0) : null);
  return {
    runs: realSum(weights(() => true)),
    missedDeadlines: counted((k) => k.outcome === 2 || k.outcome === 3),
    noResponse: counted((k) => k.outcome === 3),
    errors: counted((k) => k.outcome === 1),
    over3sRate: realRatio(realSum(weights((k) => k.slow)) ?? 0, realSum(weights((k) => k.acked))),
    p50Ms: ackQuantile(ack, 0.5),
    p95Ms: ackQuantile(ack, 0.95),
    p99Ms: ackQuantile(ack, 0.99),
  };
}

/**
 * The bot's latest process gauges: the latest sample of each slot still reporting within 2 minutes of the newest
 * sample of its gauge in the last day. Only those last minutes are read, once the newest samples are known.
 */
async function processGauges(m: Mongo, appId: string, newest: readonly { _id: string; newest: Date }[], now: Date) {
  if (newest.length === 0) return {};
  const dayAgo = now.getTime() - DAY;
  const latest = await m.c.gauges
    .aggregate<{ _id: string; worst: number; total: number }>([
      {
        $match: {
          '_id.appId': appId,
          $or: newest.map((n) => ({
            '_id.name': n._id,
            '_id.ts': { $gt: new Date(Math.max(dayAgo, n.newest.getTime() - 2 * MINUTE)) },
          })),
        },
      },
      { $set: { health: { appId: '$_id.appId', instance: '$_id.instance' } } },
      ...healthOf(m, 'health'),
      {
        $group: {
          _id: { name: '$_id.name', slot: slotOf('$_id.shard', '$health', '$_id.instance') },
          value: { $top: { sortBy: { '_id.ts': -1 }, output: '$value' } },
        },
      },
      { $group: { _id: '$_id.name', worst: { $max: '$value' }, total: { $sum: '$value' } } },
    ])
    .toArray();
  return Object.fromEntries(latest.map((r) => [r._id, r._id === 'eventloop.p99_ms' ? r.worst : r.total]));
}

/**
 * Reliability page: deadlines, errors, REST, rate limits, budgets, shards, process and SDK health. Interactions only:
 * message commands have no response or deadline, and show on the Commands page.
 */
async function reliability(
  m: Mongo,
  appId: string,
  range: { from: string; to: string },
  now: Date,
): Promise<Reliability> {
  const from = new Date(range.from);
  const to = new Date(range.to);
  const dayAgo = new Date(now.getTime() - DAY);
  const source = rollupSource(m, from, now);
  const [rf, [rest], [budget], info, shards, events, newest, sdks] = await Promise.all([
    rawFrom(m, appId, from, now),
    source.rollups
      .aggregate<{
        routes: {
          _id: { method: string; route: string };
          calls: number;
          failures: number;
          failing: number;
          retries: number;
          hist: number[] | null;
        }[];
        limits: { _id: { scope: string; route: string }; count: number; maxRetryAfter: number | null }[];
      }>([
        {
          $match: { appId, metric: { $in: ['rest.calls', 'rest.ratelimits'] }, bucket: { $gte: source.from, $lt: to } },
        },
        {
          $facet: {
            routes: [
              { $match: { metric: 'rest.calls' } },
              {
                $group: {
                  _id: { method: '$dims.method', route: '$dims.route' },
                  calls: { $sum: '$count' },
                  failures: { $sum: { $cond: [{ $gte: ['$dims.status', 400] }, '$count', 0] } },
                  failing: { $sum: { $cond: [{ $gte: ['$dims.status', 400] }, 1, 0] } },
                  retries: { $sum: '$sum' },
                  hists: { $push: '$hist' },
                },
              },
              { $sort: { calls: -1, '_id.method': 1, '_id.route': 1 } },
              { $limit: 50 },
              { $project: { calls: 1, failures: 1, failing: 1, retries: 1, hist: sumHistograms('$hists') } },
            ],
            limits: [
              { $match: { metric: 'rest.ratelimits' } },
              {
                $group: {
                  _id: { scope: '$dims.scope', route: '$dims.route' },
                  count: { $sum: '$count' },
                  maxRetryAfter: { $max: '$max' },
                },
              },
              { $sort: { count: -1, '_id.scope': 1, '_id.route': 1 } },
              { $limit: 25 },
            ],
          },
        },
      ])
      .toArray(),
    m.c.restInvalid
      .aggregate<{ used: number; shared: number }>([
        { $match: { appId, ts: { $gt: new Date(now.getTime() - 10 * MINUTE) } } },
        {
          $group: {
            _id: null,
            used: { $sum: { $add: ['$count401', '$count403', '$count429'] } },
            shared: { $sum: '$shared429' },
          },
        },
      ])
      .toArray(),
    m.c.appInfo.findOne({ _id: appId }),
    m.c.gauges
      .aggregate<{ _id: number; ping: number; ts: Date }>([
        { $match: { '_id.appId': appId, '_id.name': 'shard.ping_ms', '_id.ts': { $gt: dayAgo } } },
        {
          $group: { _id: '$_id.shard', latest: { $top: { sortBy: { '_id.ts': -1 }, output: ['$value', '$_id.ts'] } } },
        },
        { $project: { ping: { $arrayElemAt: ['$latest', 0] }, ts: { $arrayElemAt: ['$latest', 1] } } },
        { $sort: { _id: 1 } },
      ])
      .toArray(),
    m.c.shardEvents
      .find({ '_id.appId': appId, '_id.ts': { $gte: from, $lt: to } })
      .sort({ '_id.ts': -1 })
      .limit(50)
      .toArray(),
    m.c.gauges
      .aggregate<{ _id: string; newest: Date }>([
        { $match: { '_id.appId': appId, '_id.name': { $in: PROCESS_GAUGES }, '_id.ts': { $gt: dayAgo } } },
        { $group: { _id: '$_id.name', newest: { $max: '$_id.ts' } } },
      ])
      .toArray(),
    sdkInstances(m, appId),
  ]);
  const [[runs], process] = await Promise.all([
    m.c.interactions
      .aggregate<{
        groups: RunGroup[];
        ack: { _id: number; w: number }[];
        codes: { _id: { key: string; w: number }; n: number }[];
      }>([
        { $match: { appId, ts: { $gte: rf, $lt: to }, kind: { $ne: KIND.message_command } } },
        {
          $facet: {
            groups: [
              {
                $group: {
                  _id: {
                    w: '$weight',
                    outcome: '$outcome',
                    slow: { $gt: ['$ackMs', 3000] },
                    acked: { $ne: [{ $ifNull: ['$ackMs', null] }, null] },
                  },
                  n: { $sum: 1 },
                },
              },
            ],
            ack: ACK_WEIGHTS,
            codes: [
              { $match: { outcome: { $in: [1, 2] } } },
              {
                $group: {
                  _id: { key: { $ifNull: [{ $toString: '$errorCode' }, '$errorClass', 'unknown'] }, w: '$weight' },
                  n: { $sum: 1 },
                },
              },
            ],
          },
        },
      ])
      .toArray(),
    processGauges(m, appId, newest, now),
  ]);
  const codes = new Map<string, WeightRows[]>();
  for (const c of runs?.codes ?? []) codes.set(c._id.key, [...(codes.get(c._id.key) ?? []), { w: c._id.w, n: c.n }]);
  const used = budget?.used ?? 0;
  return {
    from: rf.toISOString(),
    totals: runTotals(runs?.groups ?? [], runs?.ack ?? []),
    errorsByCode: [...codes]
      .map(([key, weights]) => ({ key, value: realSum(weights) ?? 0 }))
      .sort((a, b) => b.value - a.value || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .slice(0, 10),
    routes: (rest?.routes ?? []).map((r) => ({
      method: r._id.method,
      route: r._id.route,
      calls: r.calls,
      failures: r.failing > 0 ? r.failures : null,
      retries: r.retries,
      p95Ms: histQuantile(r.hist, 0.95),
    })),
    rateLimits: (rest?.limits ?? []).map((r) => ({
      scope: r._id.scope,
      route: r._id.route,
      count: r.count,
      maxRetryAfter: r.maxRetryAfter ?? null,
    })),
    invalidBudget: { used, limit: 10_000, share: used / 10_000, shared429: budget?.shared ?? 0 },
    identify: info
      ? {
          remaining: info.sessionStartRemaining ?? null,
          total: info.sessionStartTotal ?? null,
          nodeVersion: info.nodeVersion ?? null,
          libVersion: info.libVersion ?? null,
          sdkVersion: info.sdkVersion ?? null,
          release: info.release ?? null,
          ts: info.ts,
        }
      : null,
    shards: shards.map((s) => ({
      shard: s._id,
      ping: s.ping,
      ts: s.ts,
      stale: s.ts.getTime() < now.getTime() - 2 * MINUTE,
    })),
    shardEvents: events.map((e) => ({
      ts: e._id.ts,
      shard: e._id.shard,
      state: e._id.state,
      closeCode: e.closeCode ?? null,
      replayed: e.replayed ?? null,
    })),
    process,
    sdkInstances: sdks,
  };
}

export function mongoHealthQueries(m: Mongo): Pick<QueryStorage, 'gauge' | 'bursts' | 'reliability'> {
  return {
    gauge: (appId, spec) => gauge(m, appId, spec),
    bursts: (appId, spec, now) => bursts(m, appId, spec, now),
    reliability: (appId, spec, now) => reliability(m, appId, spec.range, now),
  };
}
