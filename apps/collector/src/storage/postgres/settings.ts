import type { Db } from '../../db.js';
import type { SettingKey, SettingStorage, SettingValues } from '../store.js';

export function postgresSettings(db: Db): SettingStorage {
  return {
    async get<K extends SettingKey>(appId: string, key: K) {
      const res = await db.query<{ value: SettingValues[K] }>(
        'SELECT value FROM settings WHERE app_id = $1 AND key = $2',
        [appId, key],
      );
      return res.rows[0]?.value;
    },

    async all(appId) {
      const rows = await db.query<{ key: string; value: unknown }>(
        'SELECT key, value FROM settings WHERE app_id = $1',
        [appId],
      );
      return Object.fromEntries(rows.rows.map((r) => [r.key, r.value]));
    },

    async set(appId, key, value) {
      await db.query(
        `INSERT INTO settings (app_id, key, value) VALUES ($1, $2, $3)
         ON CONFLICT (app_id, key) DO UPDATE SET value = EXCLUDED.value`,
        [appId, key, JSON.stringify(value)],
      );
    },

    async delete(appId, key) {
      await db.query('DELETE FROM settings WHERE app_id = $1 AND key = $2', [appId, key]);
    },

    async supportsTimeZone(name) {
      // Every chart query converts with the app's zone, so PostgreSQL must know it, not just this runtime.
      const known = await db.query('SELECT 1 FROM pg_timezone_names WHERE name = $1', [name]);
      return Boolean(known.rowCount);
    },
  };
}
