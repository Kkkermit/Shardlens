import { Binary } from 'mongodb';
import type { SaltStorage } from '../store.js';
import type { Mongo } from './connect.js';
import { uniquesOfPeriod } from './uniques.js';

const bytes = (b: Binary) => Buffer.from(b.buffer);

export function mongoSalts({ c }: Mongo): SaltStorage {
  return {
    async ensure(appId, salt) {
      await c.salts.updateOne(
        { _id: { appId, period: salt.period } },
        {
          $setOnInsert: {
            secret: new Binary(salt.secret),
            periodEnd: salt.periodEnd,
            destroyAfter: salt.destroyAfter,
          },
        },
        { upsert: true },
      );
    },

    async alive(appId, periods, now) {
      if (periods.length === 0) return [];
      const salts = await c.salts
        .find({
          _id: { $in: periods.map((period) => ({ appId, period })) },
          secret: { $exists: true },
          destroyAfter: { $gt: now },
        })
        .toArray();
      return salts.flatMap((s) => (s.secret ? [{ period: s._id.period, secret: bytes(s.secret) }] : []));
    },

    async livePeriods(appId, now) {
      // Every batch asks: the `destroyAfter` index finds the few salts still alive instead of every one the app had.
      const salts = await c.salts
        .find({ destroyAfter: { $gt: now }, '_id.appId': appId, secret: { $exists: true } }, { projection: { _id: 1 } })
        .toArray();
      return new Set(salts.map((s) => s._id.period));
    },

    async secret(appId, period) {
      const salt = await c.salts.findOne({ _id: { appId, period }, destroyAfter: { $gt: new Date() } });
      return salt?.secret ? bytes(salt.secret) : undefined;
    },

    async liveSecrets(appId) {
      const salts = await c.salts.find({ '_id.appId': appId, secret: { $exists: true } }).toArray();
      return salts.flatMap((s) => (s.secret ? [bytes(s.secret)] : []));
    },

    async expired(now) {
      const salts = await c.salts
        .find({ destroyAfter: { $lte: now }, secret: { $exists: true } }, { projection: { _id: 1 } })
        .toArray();
      return salts.map((s) => ({ appId: s._id.appId, period: s._id.period }));
    },

    async destroy(appId, period, now) {
      // Hashes first, then the secret: a run stopped in between finds the salt still due and finishes it.
      await c.uniques.deleteMany(uniquesOfPeriod(appId, period));
      await c.salts.updateOne({ _id: { appId, period } }, { $unset: { secret: '' }, $set: { destroyedAt: now } });
    },
  };
}
