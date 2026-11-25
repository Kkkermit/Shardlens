import type { QueryAnswer, QueryStorage } from '../../store.js';
import type { Mongo } from '../connect.js';
import { dim } from './rollup-reads.js';
import { periodStartOf } from './salt-period-start.js';
import { sdkInstances } from './sdk-instances.js';

const DAY = 86_400_000;

/** The home page, as `postgres/query/pages.ts` answers it: one read per section, in parallel after the app's own. */
async function overview(m: Mongo, appId: string, now: Date): Promise<QueryAnswer<'overview'>> {
  const { c } = m;
  const app = await c.apps.findOne({ _id: appId });
  const periodStart = periodStartOf(app?.saltPeriod, now);
  const failed = { $and: [{ $ne: [dim('outcome'), null] }, { $ne: [dim('outcome'), '0'] }] };
  const [info, sdks, runs, servers, mau, lastEvent, required] = await Promise.all([
    c.appInfo.findOne({ _id: appId }),
    sdkInstances(m, appId),
    c.rollup1h
      .aggregate<{ _id: string; runs: number; failures: number; failing: number }>([
        { $match: { appId, metric: 'interactions', bucket: { $gte: new Date(now.getTime() - 30 * DAY) } } },
        {
          $group: {
            _id: { $dateToString: { date: '$bucket', format: '%Y-%m-%d' } },
            runs: { $sum: '$count' },
            failures: { $sum: { $cond: [failed, '$count', 0] } },
            failing: { $sum: { $cond: [failed, 1, 0] } },
          },
        },
        { $sort: { _id: 1 } },
      ])
      .toArray(),
    c.guilds.countDocuments({ '_id.appId': appId, leftAt: { $exists: false } }),
    c.uniqueCounts.findOne(
      { _id: { appId, grain: 'month', startDay: periodStart, scope: 'global', scopeKey: '*' } },
      { projection: { users: 1 } },
    ),
    // The newest minute of each metric, read from the end of the index rather than every minute of two weeks, kept
    // when it is within the last 14 days by the database's clock (PostgreSQL's `now()`).
    c.rollup1m
      .aggregate<{ _id: string; ts: Date }>([
        { $match: { appId } },
        { $sort: { appId: -1, metric: -1, bucket: -1 } },
        { $group: { _id: '$metric', ts: { $first: '$bucket' } } },
        { $match: { $expr: { $gt: ['$ts', { $subtract: ['$$NOW', 14 * DAY] }] } } },
      ])
      .toArray(),
    c.settings.countDocuments({ _id: { appId, key: 'required_permissions' } }, { limit: 1 }),
  ]);
  const lastEventAt = lastEvent.reduce<Date | null>((last, r) => (last && last >= r.ts ? last : r.ts), null);
  const appInfo = info && {
    ts: info.ts,
    name: info.name,
    approxGuilds: info.approxGuilds ?? null,
    approxUserInstalls: info.approxUserInstalls ?? null,
    approxUserAuthorizations: info.approxUserAuths ?? null,
    eventWebhooksStatus: info.eventWebhooksStatus ?? null,
    sessionStartRemaining: info.sessionStartRemaining ?? null,
    sessionStartTotal: info.sessionStartTotal ?? null,
    nodeVersion: info.nodeVersion ?? null,
    libVersion: info.libVersion ?? null,
    sdkVersion: info.sdkVersion ?? null,
    release: info.release ?? null,
  };
  return {
    app: app && {
      id: app._id,
      name: app.name,
      mode: app.mode,
      saltPeriod: app.saltPeriod,
      timezone: app.timezone,
      rawRetentionDays: app.rawRetentionDays,
    },
    appInfo,
    sdkInstances: sdks,
    // A day's failures are `null`, not 0, when none of its rollups failed: `sum() FILTER` over no rows.
    runs30d: runs.map((r) => ({ day: r._id, runs: r.runs, failures: r.failing > 0 ? r.failures : null })),
    servers,
    uniqueUsersThisPeriod: mau?.users ?? null,
    periodStart,
    lastEventAt,
    checklist: {
      receivingEvents: lastEventAt !== null,
      appInfoReceived: appInfo !== null,
      webhookEventsEnabled: appInfo?.eventWebhooksStatus === 2,
      requiredPermissionsSet: required > 0,
    },
  };
}

export function mongoOverviewQueries(m: Mongo): Pick<QueryStorage, 'overview'> {
  return { overview: (appId, _spec, now) => overview(m, appId, now) };
}
