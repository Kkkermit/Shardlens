import type { DemoStorage } from '../store.js';
import type { Mongo } from './connect.js';

export function mongoDemo({ c }: Mongo): DemoStorage {
  return {
    async isEmpty(appId) {
      return (await c.interactions.countDocuments({ appId }, { limit: 1 })) === 0;
    },

    async extendSalt(appId, period) {
      await c.salts.updateOne(
        { _id: { appId, period }, secret: { $exists: true } },
        { $max: { destroyAfter: new Date(Date.now() + 3_600_000) } },
      );
    },

    async clearLateMarks() {
      await c.dirtyBuckets.deleteMany({});
    },
  };
}
