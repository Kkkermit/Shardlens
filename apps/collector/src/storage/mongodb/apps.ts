import type { AppMeta, AppRecord, AppStorage } from '../store.js';
import type { AppDoc } from './collections.js';
import type { Mongo } from './connect.js';

const record = (app: AppDoc): AppRecord => ({
  mode: app.mode,
  saltPeriod: app.saltPeriod,
  timezone: app.timezone,
  rawRetentionDays: app.rawRetentionDays,
});

export function mongoApps({ c }: Mongo): AppStorage {
  return {
    async register(appId, name) {
      await c.apps.updateOne(
        { _id: appId },
        {
          $setOnInsert: {
            name: name ?? '',
            mode: 'privacy',
            saltPeriod: 'month',
            timezone: 'UTC',
            rawRetentionDays: 35,
            baselineDone: false,
            createdAt: new Date(),
          },
        },
        { upsert: true },
      );
    },

    async get(appId) {
      const app = await c.apps.findOne({ _id: appId });
      return app ? record(app) : undefined;
    },

    async list() {
      const apps = await c.apps.find({}, { projection: { saltPeriod: 1 } }).toArray();
      return apps.map((a) => ({ appId: a._id, saltPeriod: a.saltPeriod }));
    },

    async update(appId, changes) {
      const set: Partial<AppRecord> = {};
      if (changes.timezone !== undefined) set.timezone = changes.timezone;
      if (changes.rawRetentionDays !== undefined) set.rawRetentionDays = changes.rawRetentionDays;
      if (changes.mode !== undefined) set.mode = changes.mode;
      if (changes.saltPeriod !== undefined) set.saltPeriod = changes.saltPeriod;
      if (Object.keys(set).length > 0) await c.apps.updateOne({ _id: appId }, { $set: set });
    },

    async setMode(appId, mode) {
      const changed = await c.apps.updateOne({ _id: appId, mode: { $ne: mode } }, { $set: { mode } });
      return changed.modifiedCount > 0;
    },

    async meta(appId): Promise<AppMeta | undefined> {
      const [app, info] = await Promise.all([
        c.apps.findOne({ _id: appId }),
        c.appInfo.findOne({ _id: appId }, { projection: { name: 1 } }),
      ]);
      if (!app) return undefined;
      return { appId, name: app.name || (info?.name ?? 'Your bot'), ...record(app) };
    },

    async isDashboardUser(appId, userId) {
      const info = await c.appInfo.findOne({ _id: appId }, { projection: { dashboardUserIds: 1 } });
      return info ? info.dashboardUserIds.includes(userId) : undefined;
    },

    async hasReported(appId) {
      return (await c.appInfo.countDocuments({ _id: appId }, { limit: 1 })) > 0;
    },
  };
}
