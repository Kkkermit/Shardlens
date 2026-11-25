import type { AggregationCursor, Document } from 'mongodb';
import { KIND } from '../../../ingest/codes.js';
import type { Spec } from '../../../query/spec.js';
import type { QueryAnswer, QueryStorage } from '../../store.js';
import type { Mongo } from '../connect.js';
import { interpolate, jsonText, real } from './pg-values.js';
import { dayText, truncWall, wallClock } from './zoned-buckets.js';

/*
 * Funnels, retention cohorts and custom-event breakdowns, as `postgres/query/funnels.ts` answers them. They read single
 * events, linking a person's steps by their salted hash inside one aggregation: only counts and days leave the
 * database, never a hash. A hash changes with the salt period, so a journey that crosses a period boundary counts as
 * two people.
 */

const DAY = 86_400_000;
const COMMAND_KINDS = [
  KIND.chat_input,
  KIND.user_context,
  KIND.message_context,
  KIND.primary_entry_point,
  KIND.message_command,
];

type Step = Spec<'funnel'>['steps'][number];

interface Aggregatable {
  readonly collectionName: string;
  aggregate<T extends Document>(pipeline: Document[]): AggregationCursor<T>;
}

/** Single events of one collection, and the stages that shape them before they join the others. */
interface Part {
  from: Aggregatable;
  match: Document;
  stages: Document[];
}

/** PostgreSQL's `stepSource`: the single events that are one step (or, for `any`, anything a person did). */
function stepSources(m: Mongo, appId: string, step: Step | 'any', from: Date, to: Date): Omit<Part, 'stages'>[] {
  const ts = { $gte: from, $lt: to };
  const { interactions, customEvents } = m.c;
  if (step === 'any') {
    return [
      { from: interactions, match: { appId, ts } },
      { from: customEvents, match: { appId, ts, userHash: { $exists: true } } },
    ];
  }
  if (step.type === 'event') {
    return [{ from: customEvents, match: { appId, name: step.name, ts, userHash: { $exists: true } } }];
  }
  return [{ from: interactions, match: { appId, command: step.name, ts, kind: { $in: COMMAND_KINDS } } }];
}

/** One aggregation over several collections: the first part's, with the others' events added by `$unionWith`. */
function union<T extends Document>(parts: Part[], then: Document[]): Promise<T[]> {
  const [first, ...rest] = parts;
  if (!first) throw new Error('MongoStore: a union of no collections');
  return first.from
    .aggregate<T>([
      { $match: first.match },
      ...first.stages,
      ...rest.map((p) => ({
        $unionWith: { coll: p.from.collectionName, pipeline: [{ $match: p.match }, ...p.stages] },
      })),
      ...then,
    ])
    .toArray();
}

const missing = (value: unknown) => ({ $eq: [{ $type: value }, 'missing'] });

/** `percentile_cont(0.5)` of an array, as its two middle values and the share between them (`null` when empty). */
function median(values: string): Document {
  return {
    $let: {
      vars: { v: { $sortArray: { input: values, sortBy: 1 } } },
      in: {
        $let: {
          vars: { pos: { $multiply: [0.5, { $subtract: [{ $size: '$$v' }, 1] }] } },
          in: {
            $cond: [
              { $eq: [{ $size: '$$v' }, 0] },
              null,
              {
                lo: { $arrayElemAt: ['$$v', { $toInt: { $floor: '$$pos' } }] },
                hi: { $arrayElemAt: ['$$v', { $toInt: { $ceil: '$$pos' } }] },
                share: { $subtract: ['$$pos', { $floor: '$$pos' }] },
              },
            ],
          },
        },
      },
    },
  };
}

type Median = { lo: number; hi: number; share: number } | null;

/**
 * Conversion through 2–5 steps, each within `windowHours` of entering the funnel, in order. People enter with their
 * first step 1 in the range; a later step counts when it comes after the step before it and no later than the window
 * after entering. Each person's steps are found from their events in order of the steps, as PostgreSQL's chain of
 * joins finds them.
 */
async function funnel(m: Mongo, appId: string, spec: Spec<'funnel'>): Promise<QueryAnswer<'funnel'>> {
  const from = new Date(spec.range.from);
  const to = new Date(spec.range.to);
  const windowMs = spec.windowHours * 3_600_000;
  const steps = spec.steps.map((_, i) => i + 1);
  const later = steps.slice(1);
  const parts = spec.steps.flatMap((step, i) =>
    // Step 1 must happen inside the range; later steps may happen up to the window after it ends.
    stepSources(m, appId, step, from, i === 0 ? to : new Date(to.getTime() + windowMs)).map((source) => ({
      ...source,
      stages: [{ $project: { _id: 0, u: '$userHash', t: '$ts', s: { $literal: i + 1 } } }],
    })),
  );
  const reached = (n: number) => ({
    $cond: [
      { $eq: [`$t${n - 1}`, null] },
      null,
      {
        $min: {
          $map: {
            input: {
              $filter: {
                input: '$e',
                cond: {
                  $and: [
                    { $eq: ['$$this.s', n] },
                    { $gt: ['$$this.t', `$t${n - 1}`] },
                    { $lte: ['$$this.t', { $add: ['$t1', windowMs] }] },
                  ],
                },
              },
            },
            in: '$$this.t',
          },
        },
      },
    ],
  });
  const counts = Object.fromEntries(
    steps.map((n) => [`s${n}`, n === 1 ? { $sum: 1 } : { $sum: { $cond: [missing(`$d${n}`), 0, 1] } }]),
  );
  const [result] = await union<{ days: Record<string, number | string>[]; total: Record<string, number | Median>[] }>(
    parts,
    [
      {
        $group: {
          _id: '$u',
          t1: { $min: { $cond: [{ $eq: ['$s', 1] }, '$t', '$$REMOVE'] } },
          e: { $push: { $cond: [{ $eq: ['$s', 1] }, '$$REMOVE', { s: '$s', t: '$t' }] } },
        },
      },
      { $match: { t1: { $ne: null } } },
      ...later.map((n) => ({ $addFields: { [`t${n}`]: reached(n) } })),
      {
        $project: {
          _id: 0,
          day: { $dateToString: { date: '$t1', format: '%Y-%m-%d', timezone: { $literal: spec.timezone } } },
          ...Object.fromEntries(
            later.map((n) => [
              `d${n}`,
              { $cond: [{ $eq: [`$t${n}`, null] }, '$$REMOVE', { $divide: [{ $subtract: [`$t${n}`, '$t1'] }, 1000] }] },
            ]),
          ),
        },
      },
      {
        $facet: {
          days: [{ $group: { _id: '$day', ...counts } }, { $sort: { _id: 1 } }],
          total: [
            {
              $group: { _id: null, ...counts, ...Object.fromEntries(later.map((n) => [`d${n}`, { $push: `$d${n}` }])) },
            },
            {
              $project: {
                ...Object.fromEntries(steps.map((n) => [`s${n}`, 1])),
                ...Object.fromEntries(later.map((n) => [`m${n}`, median(`$d${n}`)])),
              },
            },
          ],
        },
      },
    ],
  );
  const total = result?.total[0];
  return {
    windowHours: spec.windowHours,
    timezone: spec.timezone,
    steps: spec.steps.map((step, i) => {
      const m = total?.[`m${i + 1}`] as Median | undefined;
      return {
        // The bare name: a command may be a prefix command, which the dashboard writes without a slash.
        label: step.name,
        type: step.type,
        name: step.name,
        users: Number(total?.[`s${i + 1}`] ?? 0),
        medianSeconds: i === 0 || !m ? null : interpolate(m.lo, m.hi, m.share),
      };
    }),
    cohorts: (result?.days ?? []).map((r) => ({
      day: String(r._id),
      users: steps.map((n) => Number(r[`s${n}`] ?? 0)),
    })),
  };
}

/**
 * The cohort builder: people who did `start` in the range, grouped by the day or week they first did it, and how many
 * of each cohort did `return` (or anything at all) 1, 2, … periods later. A period is counted on the wall clock, from
 * the cohort's start, so the day an event is on decides its period: return events are first cut to one per person and
 * day, keeping the day's last, which comes after the start whenever any of that day's does.
 */
async function retention(m: Mongo, appId: string, spec: Spec<'retention'>): Promise<QueryAnswer<'retention'>> {
  const from = new Date(spec.range.from);
  const to = new Date(spec.range.to);
  const periods = spec.interval === 'day' ? 14 : 8;
  const periodMs = (spec.interval === 'day' ? 1 : 7) * DAY;
  const zone = spec.timezone;
  const parts: Part[] = [
    ...stepSources(m, appId, spec.start, from, to).map((source) => ({
      ...source,
      stages: [{ $project: { _id: 0, u: '$userHash', t: '$ts' } }],
    })),
    ...stepSources(m, appId, spec.return, from, new Date(to.getTime() + periods * periodMs)).map((source) => ({
      ...source,
      stages: [
        { $group: { _id: { u: '$userHash', d: truncWall(wallClock('$ts', zone), 'day') }, t: { $max: '$ts' } } },
        { $project: { _id: 0, u: '$_id.u', d: '$_id.d', t: 1 } },
      ],
    })),
  ];
  const rows = await union<{ _id: { c: string; p: number }; users: number }>(parts, [
    {
      $group: {
        _id: '$u',
        t0: { $min: { $cond: [missing('$d'), '$t', '$$REMOVE'] } },
        back: { $push: { $cond: [missing('$d'), '$$REMOVE', { d: '$d', t: '$t' }] } },
      },
    },
    { $match: { t0: { $ne: null } } },
    { $addFields: { c: truncWall(wallClock('$t0', zone), spec.interval) } },
    {
      $project: {
        cohort: dayText('$c'),
        p: {
          $concatArrays: [
            [0],
            {
              $setUnion: [
                {
                  $filter: {
                    input: {
                      $map: {
                        input: '$back',
                        in: {
                          $cond: [
                            { $gt: ['$$this.t', '$t0'] },
                            { $floor: { $divide: [{ $subtract: ['$$this.d', '$c'] }, periodMs] } },
                            null,
                          ],
                        },
                      },
                    },
                    cond: { $and: [{ $gte: ['$$this', 1] }, { $lte: ['$$this', periods] }] },
                  },
                },
              ],
            },
          ],
        },
      },
    },
    { $unwind: '$p' },
    { $group: { _id: { c: '$cohort', p: '$p' }, users: { $sum: 1 } } },
    { $sort: { '_id.c': 1, '_id.p': 1 } },
  ]);
  const cohorts = new Map<string, { cohort: string; size: number; retained: number[] }>();
  for (const { _id, users } of rows) {
    const entry = cohorts.get(_id.c) ?? { cohort: _id.c, size: 0, retained: new Array<number>(periods).fill(0) };
    if (_id.p === 0) entry.size = users;
    else entry.retained[_id.p - 1] = users;
    cohorts.set(_id.c, entry);
  }
  return {
    interval: spec.interval,
    timezone: spec.timezone,
    start: spec.start.type === 'command' ? `/${spec.start.name}` : spec.start.name,
    return: spec.return === 'any' ? 'any activity' : spec.return.name,
    periods,
    cohorts: [...cohorts.values()].filter((c) => c.size > 0),
  };
}

/** Custom events in the range: count, distinct people, last seen. */
async function events(m: Mongo, appId: string, spec: Spec<'events'>): Promise<QueryAnswer<'events'>> {
  const rows = await m.c.customEvents
    .aggregate<{ _id: string; count: number; users: number; lastSeen: Date }>([
      { $match: { appId, ts: { $gte: new Date(spec.range.from), $lt: new Date(spec.range.to) } } },
      { $group: { _id: { n: '$name', u: '$userHash' }, count: { $sum: '$weight' }, last: { $max: '$ts' } } },
      {
        $group: {
          _id: '$_id.n',
          count: { $sum: '$count' },
          users: { $sum: { $cond: [{ $eq: [{ $type: '$_id.u' }, 'binData'] }, 1, 0] } },
          lastSeen: { $max: '$last' },
        },
      },
      { $sort: { count: -1, _id: 1 } },
      { $limit: 200 },
    ])
    .toArray();
  return { rows: rows.map((r) => ({ name: r._id, count: real(r.count), users: r.users, lastSeen: r.lastSeen })) };
}

/** One custom event's property keys, or the top values of one property, as text. */
async function eventProps(m: Mongo, appId: string, spec: Spec<'eventProps'>): Promise<QueryAnswer<'eventProps'>> {
  const match = { appId, name: spec.name, ts: { $gte: new Date(spec.range.from), $lt: new Date(spec.range.to) } };
  const top = [{ $sort: { count: -1, _id: 1 } }, { $limit: 50 }];
  if (!spec.prop) {
    const keys = await m.c.customEvents
      .aggregate<{ _id: string; count: number }>([
        { $match: match },
        { $project: { weight: 1, k: { $objectToArray: '$props' } } },
        { $unwind: '$k' },
        { $group: { _id: '$k.k', count: { $sum: '$weight' } } },
        ...top,
      ])
      .toArray();
    return { name: spec.name, keys: keys.map((r) => ({ key: r._id, count: real(r.count) })) };
  }
  // A name that is not a field path: a property may be called `a.b` or `$x`.
  const value = { $getField: { field: { $literal: spec.prop }, input: '$props' } };
  const values = await m.c.customEvents
    .aggregate<{ _id: string; count: number }>([
      { $match: { ...match, $expr: { $not: [missing(value)] } } },
      { $group: { _id: { $ifNull: [jsonText(value), 'null'] }, count: { $sum: '$weight' } } },
      ...top,
    ])
    .toArray();
  return { name: spec.name, prop: spec.prop, values: values.map((r) => ({ value: r._id, count: real(r.count) })) };
}

export function mongoFunnelsQueries(m: Mongo): Pick<QueryStorage, 'events' | 'eventProps' | 'funnel' | 'retention'> {
  return {
    events: (appId, spec) => events(m, appId, spec),
    eventProps: (appId, spec) => eventProps(m, appId, spec),
    funnel: (appId, spec) => funnel(m, appId, spec),
    retention: (appId, spec) => retention(m, appId, spec),
  };
}
