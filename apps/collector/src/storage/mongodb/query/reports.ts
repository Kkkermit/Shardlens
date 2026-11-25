import type { QueryAnswer, QueryStorage, SettingValues } from '../../store.js';
import type { Mongo } from '../connect.js';
import { idPrefix } from './id-prefix.js';
import { premiumShare } from './premium-share.js';
import { rawFrom } from './read-window.js';
import { dayText, wallClock } from './zoned-buckets.js';

const DAY = 86_400_000;

type Range = { from: string; to: string };
type StatusCounts = { active: number; ending: number; inactive: number };

/** Premium page: entitlements and subscriptions by SKU, premium share of runs, estimated revenue. */
async function premium(m: Mongo, appId: string, range: Range, now: Date): Promise<QueryAnswer<'premium'>> {
  const from = new Date(range.from);
  const to = new Date(range.to);
  const [rawStart, info, prices, changes, active, subscriptions] = await Promise.all([
    rawFrom(m, appId, from, now),
    m.c.appInfo.findOne({ _id: appId }, { projection: { skus: 1 } }),
    m.c.settings.findOne({ _id: { appId, key: 'sku_prices' } }),
    m.c.entitlements
      .aggregate<{ _id: { sku: string; action: string }; count: number; testCount: number }>([
        { $match: { appId, ts: { $gte: from, $lt: to } } },
        {
          $group: {
            _id: { sku: '$skuId', action: '$action' },
            count: { $sum: 1 },
            testCount: { $sum: { $cond: [{ $eq: ['$entitlementType', 4] }, 1, 0] } },
          },
        },
        // PostgreSQL orders these by the SKU as text, not as a number.
        { $sort: { '_id.sku': 1, '_id.action': 1 } },
      ])
      .toArray(),
    // Each owner's latest change of each SKU, ever: active unless it was a deletion or has ended.
    m.c.entitlements
      .aggregate<{ _id: string; active: number }>([
        { $match: { appId } },
        {
          $group: {
            _id: { sku: '$skuId', user: { $ifNull: ['$userHash', null] }, guild: { $ifNull: ['$guildId', null] } },
            latest: { $top: { sortBy: { ts: -1 }, output: { action: '$action', endsAt: '$endsAt' } } },
          },
        },
        {
          $match: {
            'latest.action': { $ne: 'delete' },
            $or: [{ 'latest.endsAt': null }, { 'latest.endsAt': { $gt: now } }],
          },
        },
        { $group: { _id: '$_id.sku', active: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ])
      .toArray(),
    // Each user's latest subscription counts once for every SKU it lists: PostgreSQL's `DISTINCT ON (user_hash)` picks
    // the row before `unnest(sku_ids)` expands it.
    m.c.subscriptions
      .aggregate<{ _id: string } & StatusCounts>([
        { $match: { appId } },
        {
          $group: {
            _id: '$userHash',
            latest: { $top: { sortBy: { ts: -1 }, output: { skus: '$skuIds', status: '$status' } } },
          },
        },
        { $unwind: '$latest.skus' },
        {
          $group: {
            _id: '$latest.skus',
            active: { $sum: { $cond: [{ $eq: ['$latest.status', 0] }, 1, 0] } },
            ending: { $sum: { $cond: [{ $eq: ['$latest.status', 1] }, 1, 0] } },
            inactive: { $sum: { $cond: [{ $eq: ['$latest.status', 2] }, 1, 0] } },
          },
        },
        { $sort: { _id: 1 } },
      ])
      .toArray(),
  ]);
  const share = await premiumShare(m, appId, rawStart, to);
  const skus = (info?.skus ?? []) as { id: string; name: string }[];
  const names = new Map(skus.map((s) => [s.id, s.name]));
  const priceMap = (prices?.value ?? {}) as SettingValues['sku_prices'];
  const revenue: Record<string, number> = {};
  for (const row of subscriptions) {
    const price = priceMap[row._id];
    if (price) revenue[price.currency] = (revenue[price.currency] ?? 0) + price.amount * (row.active + row.ending);
  }
  const label = (sku: string) => names.get(sku) ?? sku;
  return {
    changes: changes.map((r) => ({
      sku: r._id.sku,
      action: r._id.action,
      count: r.count,
      testCount: r.testCount,
      name: label(r._id.sku),
    })),
    activeEntitlements: active.map((r) => ({ sku: r._id, active: r.active, name: label(r._id) })),
    subscriptions: subscriptions.map((r) => ({
      sku: r._id,
      active: r.active,
      ending: r.ending,
      inactive: r.inactive,
      name: label(r._id),
      price: priceMap[r._id] ?? null,
    })),
    premiumShare: share,
    estimatedMonthlyRevenue: revenue,
    pricesConfigured: Object.keys(priceMap).length > 0,
  };
}

/** User installs and uninstalls (webhook events) and Discord's approximate counts. */
async function installs(m: Mongo, appId: string, range: Range, timezone: string): Promise<QueryAnswer<'installs'>> {
  const from = new Date(range.from);
  const to = new Date(range.to);
  const authorized = { $eq: ['$type', 'APPLICATION_AUTHORIZED'] };
  const countIf = (cond: unknown) => ({ $sum: { $cond: [cond, 1, 0] } });
  const [daily, scopes, approx, info] = await Promise.all([
    m.c.webhookEvents
      .aggregate<{ _id: string; userInstalls: number; userRemovals: number; serverInstalls: number }>([
        { $match: { appId, ts: { $gte: from, $lt: to } } },
        {
          $group: {
            _id: dayText(wallClock('$ts', timezone)),
            userInstalls: countIf({ $and: [authorized, { $eq: ['$integrationType', 1] }] }),
            userRemovals: countIf({ $eq: ['$type', 'APPLICATION_DEAUTHORIZED'] }),
            serverInstalls: countIf({ $and: [authorized, { $eq: ['$integrationType', 0] }] }),
          },
        },
        { $sort: { _id: 1 } },
      ])
      .toArray(),
    m.c.webhookEvents
      .aggregate<{ _id: string; installs: number }>([
        { $match: { appId, ts: { $gte: from, $lt: to }, type: 'APPLICATION_AUTHORIZED' } },
        { $unwind: '$scopes' },
        { $group: { _id: '$scopes', installs: { $sum: 1 } } },
        { $sort: { installs: -1, _id: 1 } },
      ])
      .toArray(),
    m.c.gauges
      .aggregate<{ _id: string; value: number }>([
        { $match: { '_id.appId': appId, '_id.name': 'app.approx_user_installs', '_id.ts': { $gte: from, $lt: to } } },
        { $group: { _id: dayText('$_id.ts'), value: { $max: '$value' } } },
        { $sort: { _id: 1 } },
      ])
      .toArray(),
    m.c.appInfo.findOne({ _id: appId }, { projection: { eventWebhooksStatus: 1 } }),
  ]);
  return {
    daily: daily.map((d) => ({
      day: d._id,
      userInstalls: d.userInstalls,
      userRemovals: d.userRemovals,
      serverInstalls: d.serverInstalls,
    })),
    scopes: scopes.map((s) => ({ scope: s._id, installs: s.installs })),
    approximateUserInstalls: approx.map((a) => ({ day: a._id, value: a.value })),
    webhookStatus: info?.eventWebhooksStatus ?? null,
  };
}

/** Public badge values (opt-in per metric in settings). */
async function badge(m: Mongo, appId: string, metric: string): Promise<number | null> {
  if (metric === 'servers') return m.c.guilds.countDocuments({ '_id.appId': appId, leftAt: { $exists: false } });
  if (metric === 'users-monthly') {
    // The latest salt period's count: the app's whole-period counts are a range of `_id`, read from its end.
    const latest = await m.c.uniqueCounts
      .find({ ...idPrefix({ appId, grain: 'month' }, 'startDay'), '_id.scope': 'global' })
      .sort({ _id: -1 })
      .limit(1)
      .toArray();
    return latest[0]?.users ?? null;
  }
  if (metric === 'commands-daily') {
    const [day] = await m.c.rollup1h
      .aggregate<{ n: number }>([
        { $match: { appId, metric: 'interactions', bucket: { $gt: new Date(Date.now() - DAY) } } },
        { $group: { _id: null, n: { $sum: '$count' } } },
      ])
      .toArray();
    return day?.n ?? 0;
  }
  return null;
}

export function mongoReportsQueries(m: Mongo): Pick<QueryStorage, 'premium' | 'installs' | 'badge'> {
  return {
    premium: (appId, spec, now) => premium(m, appId, spec.range, now),
    installs: (appId, spec) => installs(m, appId, spec.range, spec.timezone),
    badge: (appId, metric) => badge(m, appId, metric),
  };
}
