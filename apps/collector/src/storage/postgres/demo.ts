import type { Db } from '../../db.js';
import type { DemoStorage } from '../store.js';

export function postgresDemo(db: Db): DemoStorage {
  return {
    async isEmpty(appId) {
      const existing = await db.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM (SELECT 1 FROM interactions WHERE app_id = $1 LIMIT 1) x',
        [appId],
      );
      return (existing.rows[0]?.n ?? 0) === 0;
    },

    async extendSalt(appId, period) {
      await db.query(
        `UPDATE salts SET destroy_after = greatest(destroy_after, now() + interval '1 hour')
          WHERE app_id = $1 AND period = $2 AND secret IS NOT NULL`,
        [appId, period],
      );
    },

    async clearLateMarks() {
      await db.query('DELETE FROM dirty_buckets');
    },
  };
}
