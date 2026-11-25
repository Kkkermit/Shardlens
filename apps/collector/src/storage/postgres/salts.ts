import type { Db } from '../../db.js';
import type { SaltStorage } from '../store.js';
import { dropUniquesPartition, ensureUniquesPartition } from './partitions.js';

export function postgresSalts(db: Db): SaltStorage {
  return {
    async ensure(appId, salt) {
      await db.query(
        `INSERT INTO salts (app_id, period, secret, period_end, destroy_after)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (app_id, period) DO NOTHING`,
        [appId, salt.period, salt.secret, salt.periodEnd, salt.destroyAfter],
      );
      await ensureUniquesPartition(db, salt.period);
    },

    async alive(appId, periods, now) {
      const res = await db.query<{ period: string; secret: Buffer }>(
        `SELECT period, secret FROM salts
          WHERE app_id = $1 AND period = ANY($2::text[]) AND secret IS NOT NULL AND destroy_after > $3`,
        [appId, periods, now],
      );
      return res.rows;
    },

    async livePeriods(appId, now) {
      const res = await db.query<{ period: string }>(
        'SELECT period FROM salts WHERE app_id = $1 AND secret IS NOT NULL AND destroy_after > $2',
        [appId, now],
      );
      return new Set(res.rows.map((r) => r.period));
    },

    async secret(appId, period) {
      const salt = await db.query<{ secret: Buffer | null }>(
        'SELECT secret FROM salts WHERE app_id = $1 AND period = $2 AND destroy_after > now()',
        [appId, period],
      );
      return salt.rows[0]?.secret ?? undefined;
    },

    async liveSecrets(appId) {
      const salts = await db.query<{ secret: Buffer }>(
        'SELECT secret FROM salts WHERE app_id = $1 AND secret IS NOT NULL',
        [appId],
      );
      return salts.rows.map((s) => s.secret);
    },

    async expired(now) {
      const expired = await db.query<{ app_id: string; period: string }>(
        'SELECT app_id, period FROM salts WHERE secret IS NOT NULL AND destroy_after <= $1',
        [now],
      );
      return expired.rows.map((r) => ({ appId: r.app_id, period: r.period }));
    },

    async destroy(appId, period, now) {
      await db.query('DELETE FROM uniques WHERE app_id = $1 AND period = $2', [appId, period]);
      await db.query('UPDATE salts SET secret = NULL, destroyed_at = $3 WHERE app_id = $1 AND period = $2', [
        appId,
        period,
        now,
      ]);
      // The partition is shared by every app with a salt for the period.
      const stillLive = await db.query('SELECT 1 FROM salts WHERE period = $1 AND secret IS NOT NULL LIMIT 1', [
        period,
      ]);
      if (stillLive.rowCount === 0) await dropUniquesPartition(db, period);
    },
  };
}
