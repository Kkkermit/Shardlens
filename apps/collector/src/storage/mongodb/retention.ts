import type { Collection, Document, Filter } from 'mongodb';
import { RETENTION_DAYS } from '../retention.js';
import type { Mongo } from './connect.js';

const DAY = 86_400_000;

const startOfDay = (ms: number) => new Date(Math.floor(ms / DAY) * DAY);

/** `months` calendar months before `now`, in UTC, the day clamped to the month's last (as PostgreSQL's intervals). */
function monthsBefore(now: Date, months: number): Date {
  const d = new Date(now);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

/**
 * Deletes an app's documents older than `before`, one value of `field` at a time, so each delete walks only its own
 * part of an index that starts with the app and `field`.
 */
async function deleteByValue<T extends Document>(
  collection: Collection<T>,
  app: Filter<T>,
  field: string,
  older: (value: unknown) => Filter<T>,
): Promise<void> {
  for (const value of await collection.distinct(field, app)) {
    await collection.deleteMany({ ...app, ...older(value) } as Filter<T>);
  }
}

/**
 * The daily job, as PostgreSQL's: hourly rollups after 13 months, servers left 90 days ago, expired sessions, access
 * and admin logs after a year, held-back snapshots after a day, SDK health of processes silent for 30 days, then
 * single events and minute rollups past retention. PostgreSQL drops shared daily partitions, so there every app's
 * single events stay as long as the longest raw retention; here each app's go by its own settings, as they stand now.
 */
export async function runRetention(m: Mongo, now: Date): Promise<void> {
  const { c } = m;
  const t = now.getTime();
  await c.sessions.deleteMany({ expiresAt: { $lt: now } });
  await c.snapshotPending.deleteMany({ ts: { $lt: new Date(t - DAY) } });
  // One document per bot process, and a restarted process is a new one.
  await c.sdkHealth.deleteMany({ ts: { $lt: new Date(t - 30 * DAY) } });

  const apps = await c.apps.find({}, { projection: { rawRetentionDays: 1 } }).toArray();
  const audit = await c.settings
    .find({ '_id.key': 'audit_retention_days' }, { projection: { _id: 1, value: 1 } })
    .toArray();
  const auditDays = new Map(audit.map((s) => [s._id.appId, Number(s.value)]));
  const yearAgo = monthsBefore(now, 12);

  for (const { _id: appId, rawRetentionDays } of apps) {
    await deleteByValue(c.rollup1h, { appId }, 'metric', (metric) => ({
      metric: String(metric),
      bucket: { $lt: monthsBefore(now, 13) },
    }));
    await c.guilds.deleteMany({ '_id.appId': appId, leftAt: { $lt: new Date(t - 90 * DAY) } });
    await c.accessLog.deleteMany({ appId, ts: { $lt: yearAgo } });
    await c.adminAudit.deleteMany({ appId, ts: { $lt: yearAgo } });

    // Whole UTC days, as PostgreSQL's daily partitions go.
    const raw = { appId, ts: { $lt: startOfDay(t - rawRetentionDays * DAY) } };
    await c.interactions.deleteMany(raw);
    await c.interactionErrors.deleteMany(raw);
    await c.restCalls.deleteMany(raw);
    await c.restInvalid.deleteMany(raw);
    await c.rateLimits.deleteMany(raw);
    await c.customEvents.deleteMany(raw);
    await c.webhookEvents.deleteMany(raw);
    const days = auditDays.get(appId);
    const kept = Math.min(90, Math.max(1, days !== undefined && Number.isFinite(days) ? days : 30));
    await c.auditLog.deleteMany({ appId, ts: { $lt: startOfDay(t - kept * DAY) } });
    await deleteByValue(c.gauges, { '_id.appId': appId }, '_id.name', (name) => ({
      '_id.name': String(name),
      '_id.ts': { $lt: startOfDay(t - RETENTION_DAYS.gauges * DAY) },
    }));
    await deleteByValue(c.rollup1m, { appId }, 'metric', (metric) => ({
      metric: String(metric),
      bucket: { $lt: startOfDay(t - RETENTION_DAYS.rollup_1m * DAY) },
    }));
  }
}
