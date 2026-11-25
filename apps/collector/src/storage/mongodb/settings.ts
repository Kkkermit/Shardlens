import { MongoServerError } from 'mongodb';
import type { SettingKey, SettingStorage, SettingValues } from '../store.js';
import type { Mongo } from './connect.js';
import { asJson } from './json.js';
import { UNKNOWN_TIME_ZONE } from './writes.js';

export function mongoSettings({ c, db }: Mongo): SettingStorage {
  return {
    async get<K extends SettingKey>(appId: string, key: K) {
      const doc = await c.settings.findOne({ _id: { appId, key } });
      return doc?.value as SettingValues[K] | undefined;
    },

    async all(appId) {
      const docs = await c.settings.find({ '_id.appId': appId }).toArray();
      return Object.fromEntries(docs.map((d) => [d._id.key, d.value]));
    },

    async set(appId, key, value) {
      await c.settings.replaceOne({ _id: { appId, key } }, { value: asJson(value) }, { upsert: true });
    },

    async delete(appId, key) {
      await c.settings.deleteOne({ _id: { appId, key } });
    },

    async supportsTimeZone(name) {
      // Charts are cut with the server's own time zone database, which may be older or newer than this runtime's.
      try {
        await db
          .aggregate([
            { $documents: [{}] },
            { $project: { _id: 0, t: { $dateToString: { date: new Date(0), timezone: { $literal: name } } } } },
          ])
          .toArray();
        return true;
      } catch (error) {
        if (error instanceof MongoServerError && error.code === UNKNOWN_TIME_ZONE) return false;
        throw error;
      }
    },
  };
}
