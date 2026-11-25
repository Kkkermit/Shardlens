import { KIND } from '../../../ingest/codes.js';
import { decodeValue } from '../../../query/dimensions.js';
import type { Spec } from '../../../query/spec.js';
import type { QueryAnswer, QueryStorage } from '../../store.js';
import type { UniqueCountDoc } from '../collections.js';
import type { Mongo } from '../connect.js';
import { premiumShare } from './premium-share.js';
import { rawFrom, rollupSource } from './read-window.js';

const DAY = 86_400_000;
const SPLITS = ['context', 'install', 'locale', 'tier'] as const;
/** Message commands have no user language or install type: they count towards the other splits only. */
const WITHOUT_MESSAGE_COMMANDS = new Set(['locale', 'install']);

type Split = (typeof SPLITS)[number];
type Audience = QueryAnswer<'audience'>;

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * The app's everyone-counts of one grain whose first day is from `first` to `last`, oldest first. Each day's is read
 * by its `_id`: a range of them would also read the counts of every command and server kept under the same days.
 */
function everyone(m: Mongo, appId: string, grain: UniqueCountDoc['_id']['grain'], first: string, last: string) {
  const ids: UniqueCountDoc['_id'][] = [];
  for (let day = Date.parse(first); day <= Date.parse(last); day += DAY) {
    ids.push({ appId, grain, startDay: isoDay(day), scope: 'global', scopeKey: '*' });
  }
  return m.c.uniqueCounts
    .find({ _id: { $in: ids } })
    .sort({ _id: 1 })
    .toArray();
}

/** The first `limit` values of each split, most runs first (PostgreSQL leaves the order of equal counts open). */
function bySplit(rows: { _id: { k: Split; v: string | number | null }; value: number }[], limit: number) {
  const splits: Audience['splits'] = {};
  const sorted = rows
    .map((r) => ({ k: r._id.k, key: r._id.v === null ? null : String(r._id.v), value: r.value }))
    .sort(
      (a, b) =>
        (a.k < b.k ? -1 : a.k > b.k ? 1 : 0) ||
        b.value - a.value ||
        (a.key === b.key ? 0 : a.key === null ? 1 : b.key === null ? -1 : a.key < b.key ? -1 : 1),
    );
  for (const r of sorted) {
    const list = splits[r.k] ?? [];
    if (list.length < limit) list.push({ key: decodeValue(r.k, r.key), value: r.value });
    splits[r.k] = list;
  }
  return splits;
}

async function audience(m: Mongo, appId: string, spec: Spec<'audience'>, now: Date): Promise<Audience> {
  const from = new Date(spec.range.from);
  const to = new Date(spec.range.to);
  // Unique users are counted per UTC day. `to` is exclusive, so the last day is the one its final millisecond is in.
  const first = isoDay(from.getTime());
  const last = isoDay(to.getTime() - 1);
  const source = rollupSource(m, from, now);
  const [rawStart, daily, weekly, periods, splits] = await Promise.all([
    rawFrom(m, appId, from, now),
    everyone(m, appId, 'day', first, last),
    everyone(m, appId, 'week', isoDay(Date.parse(first) - 6 * DAY), last),
    everyone(m, appId, 'month', isoDay(Date.parse(first) - 31 * DAY), last),
    source.rollups
      .aggregate<{ _id: { k: Split; v: string | number | null }; value: number }>([
        { $match: { appId, metric: 'interactions', bucket: { $gte: source.from, $lt: to } } },
        {
          $project: {
            count: 1,
            split: {
              $filter: {
                input: SPLITS.map((k) => ({ k, v: { $ifNull: [`$dims.${k}`, null] } })),
                cond: {
                  $or: [
                    { $not: [{ $in: ['$$this.k', [...WITHOUT_MESSAGE_COMMANDS]] }] },
                    { $ne: ['$dims.kind', KIND.message_command] },
                  ],
                },
              },
            },
          },
        },
        { $unwind: '$split' },
        { $group: { _id: { k: '$split.k', v: '$split.v' }, value: { $sum: '$count' } } },
      ])
      .toArray(),
  ]);
  const share = await premiumShare(m, appId, rawStart, to);
  const recent = daily.slice(-30);
  const avgDau = recent.length > 0 ? recent.reduce((a, r) => a + r.users, 0) / recent.length : null;
  const latestPeriod = periods.at(-1);
  return {
    daily: daily.map((d) => ({ day: d._id.startDay, users: d.users, newUsers: d.newUsers })),
    weekly: weekly.map((w) => ({ week: w._id.startDay, users: w.users })),
    periods: periods.map((p) => ({ period: p._id.startDay, users: p.users, final: p.final })),
    stickiness: avgDau !== null && latestPeriod?.users ? avgDau / latestPeriod.users : null,
    splits: bySplit(splits, 15),
    premiumShare: share,
  };
}

export function mongoAudienceQueries(m: Mongo): Pick<QueryStorage, 'audience'> {
  return { audience: (appId, spec, now) => audience(m, appId, spec, now) };
}
