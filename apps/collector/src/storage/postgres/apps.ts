import type { Db } from '../../db.js';
import type { SaltPeriod } from '../periods.js';
import type { AppMeta, AppMode, AppRecord, AppStorage } from '../store.js';

/** Column per field, in the order an update sets them. */
const COLUMNS: [keyof AppRecord, string][] = [
  ['timezone', 'timezone'],
  ['rawRetentionDays', 'raw_retention_days'],
  ['mode', 'mode'],
  ['saltPeriod', 'salt_period'],
];

export function postgresApps(db: Db): AppStorage {
  return {
    async register(appId, name) {
      if (name === undefined) {
        await db.query('INSERT INTO apps (app_id) VALUES ($1) ON CONFLICT (app_id) DO NOTHING', [appId]);
      } else {
        await db.query('INSERT INTO apps (app_id, name) VALUES ($1, $2) ON CONFLICT (app_id) DO NOTHING', [
          appId,
          name,
        ]);
      }
    },

    async get(appId) {
      const res = await db.query<{
        mode: AppMode;
        salt_period: SaltPeriod;
        timezone: string;
        raw_retention_days: number;
      }>('SELECT mode, salt_period, timezone, raw_retention_days FROM apps WHERE app_id = $1', [appId]);
      const row = res.rows[0];
      return (
        row && {
          mode: row.mode,
          saltPeriod: row.salt_period,
          timezone: row.timezone,
          rawRetentionDays: row.raw_retention_days,
        }
      );
    },

    async list() {
      const apps = await db.query<{ app_id: string; salt_period: SaltPeriod }>('SELECT app_id, salt_period FROM apps');
      return apps.rows.map((r) => ({ appId: r.app_id, saltPeriod: r.salt_period }));
    },

    async update(appId, changes) {
      const set = COLUMNS.filter(([field]) => changes[field] !== undefined);
      if (set.length === 0) return;
      // Column names come from the fixed list above, never from input.
      const sets = set.map(([, column], i) => `${column} = $${i + 2}`).join(', ');
      await db.query(`UPDATE apps SET ${sets} WHERE app_id = $1`, [appId, ...set.map(([field]) => changes[field])]);
    },

    async setMode(appId, mode) {
      const changed = await db.query('UPDATE apps SET mode = $2 WHERE app_id = $1 AND mode <> $2', [appId, mode]);
      return (changed.rowCount ?? 0) > 0;
    },

    async meta(appId) {
      const res = await db.query<AppMeta>(
        `SELECT a.app_id::text AS "appId", coalesce(nullif(a.name, ''), i.name, 'Your bot') AS name, a.mode,
                a.salt_period AS "saltPeriod", a.timezone, a.raw_retention_days AS "rawRetentionDays"
           FROM apps a LEFT JOIN app_info i USING (app_id) WHERE a.app_id = $1`,
        [appId],
      );
      return res.rows[0];
    },

    async isDashboardUser(appId, userId) {
      const res = await db.query<{ ok: boolean }>(
        'SELECT $2::bigint = ANY(dashboard_user_ids) AS ok FROM app_info WHERE app_id = $1',
        [appId, userId],
      );
      return res.rows[0]?.ok;
    },

    async hasReported(appId) {
      const reported = await db.query('SELECT 1 FROM app_info WHERE app_id = $1', [appId]);
      return reported.rowCount !== 0;
    },
  };
}
