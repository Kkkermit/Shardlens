import { Binary } from 'mongodb';
import type { ReportStorage, ReportToSend } from '../store.js';
import type { AppDoc, AppInfoDoc, ReportDoc } from './collections.js';
import type { Mongo } from './connect.js';
import { compareIds, nextId } from './ids.js';
import { instantOf, startOfDay, wallTime } from './zoned-time.js';

const DAY = 86_400_000;

/** Where `now` falls in a time zone, and the local midnights a report's period starts and ends at. */
interface LocalDay {
  hour: number;
  /** ISO weekday, 1 Monday to 7 Sunday. */
  weekday: number;
  dayStart: Date;
  weekStart: Date;
  dayEnd: Date;
}

/** As `storage/postgres/scheduled-reports.ts` works it out in SQL, wall times resolved as PostgreSQL resolves them. */
function localDay(now: Date, zone: string): LocalDay {
  const local = wallTime(now.getTime(), zone);
  const today = startOfDay(local);
  const clock = new Date(local);
  return {
    hour: clock.getUTCHours(),
    weekday: clock.getUTCDay() || 7,
    dayStart: new Date(instantOf(today - DAY, zone)),
    weekStart: new Date(instantOf(today - 7 * DAY, zone)),
    dayEnd: new Date(instantOf(today, zone)),
  };
}

/** The app's name, else the one the bot reported, else `Your bot` (`coalesce(nullif(a.name, ''), i.name, ...)`). */
function botName(app: AppDoc, info: Pick<AppInfoDoc, 'name'> | undefined): string {
  return app.name !== '' ? app.name : (info?.name ?? 'Your bot');
}

/** Reports with their periods worked out in each app's time zone, those whose app is gone left out. In ID order. */
async function withPeriods(
  { c }: Mongo,
  reports: ReportDoc[],
  now: Date,
  keep: (report: ReportDoc, day: LocalDay) => boolean,
): Promise<ReportToSend[]> {
  if (reports.length === 0) return [];
  const appIds = [...new Set(reports.map((r) => r.appId))];
  const [apps, infos] = await Promise.all([
    c.apps.find({ _id: { $in: appIds } }, { projection: { name: 1, timezone: 1 } }).toArray(),
    c.appInfo.find({ _id: { $in: appIds } }, { projection: { name: 1 } }).toArray(),
  ]);
  const appById = new Map(apps.map((a) => [a._id, a]));
  const infoById = new Map(infos.map((i) => [i._id, i]));
  const days = new Map<string, LocalDay>();
  const out: ReportToSend[] = [];
  for (const r of [...reports].sort((a, b) => compareIds(a._id, b._id))) {
    const app = appById.get(r.appId);
    if (!app) continue;
    let day = days.get(app.timezone);
    if (!day) {
      day = localDay(now, app.timezone);
      days.set(app.timezone, day);
    }
    if (!keep(r, day)) continue;
    out.push({
      id: r._id,
      appId: r.appId,
      name: r.name,
      schedule: r.schedule,
      webhook: Buffer.from(r.webhookEnc.buffer),
      timezone: app.timezone,
      bot: botName(app, infoById.get(r.appId)),
      dayStart: day.dayStart,
      weekStart: day.weekStart,
      dayEnd: day.dayEnd,
    });
  }
  return out;
}

export function mongoReports(m: Mongo): ReportStorage {
  const { c } = m;
  return {
    async list(appId) {
      const reports = await c.reports.find({ appId }).toArray();
      reports.sort((a, b) => compareIds(a._id, b._id));
      return reports.map((r) => ({
        id: r._id,
        name: r.name,
        schedule: r.schedule,
        hour: r.hour,
        weekday: r.weekday,
        webhook: Buffer.from(r.webhookEnc.buffer),
        enabled: r.enabled,
        lastSent: r.lastSent ?? null,
        lastError: r.lastError ?? null,
      }));
    },

    count: (appId) => c.reports.countDocuments({ appId }),

    async create(appId, report) {
      const id = await nextId(c, 'reports');
      await c.reports.insertOne({
        _id: id,
        appId,
        name: report.name,
        schedule: report.schedule,
        hour: report.hour,
        weekday: report.weekday,
        webhookEnc: new Binary(report.webhook),
        enabled: true,
      });
      return id;
    },

    async setEnabled(appId, id, enabled) {
      const res = await c.reports.updateOne({ _id: id, appId }, { $set: { enabled } });
      return res.matchedCount > 0;
    },

    async delete(appId, id) {
      const res = await c.reports.deleteOne({ _id: id, appId });
      return res.deletedCount > 0;
    },

    async due(now) {
      const enabled = await c.reports.find({ enabled: true }).toArray();
      return withPeriods(
        m,
        enabled,
        now,
        (r, day) =>
          day.hour >= r.hour &&
          (r.schedule === 'daily' || day.weekday === r.weekday) &&
          (r.lastSent === undefined || r.lastSent < day.dayEnd),
      );
    },

    async find(appId, id, now) {
      const report = await c.reports.findOne({ _id: id, appId });
      const [row] = await withPeriods(m, report ? [report] : [], now, () => true);
      return row;
    },

    async recordSent(id, at, error) {
      await c.reports.updateOne(
        { _id: id },
        error === null
          ? { $set: { lastSent: at }, $unset: { lastError: '' } }
          : { $set: { lastSent: at, lastError: error } },
      );
    },
  };
}
