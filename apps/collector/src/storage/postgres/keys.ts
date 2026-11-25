import type { Db } from '../../db.js';
import type { ApiKeyScope } from '../../security/keys.js';
import type { ApiKeyListing, KeyStorage } from '../store.js';

export function postgresKeys(db: Db): KeyStorage {
  return {
    async findActive(sha256) {
      const res = await db.query<{ id: string; app_id: string; scope: ApiKeyScope }>(
        'SELECT id, app_id, scope FROM api_keys WHERE sha256 = $1 AND revoked_at IS NULL',
        [sha256],
      );
      const row = res.rows[0];
      return row && { id: row.id, appId: row.app_id, scope: row.scope };
    },

    async touch(id) {
      await db.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [id]);
    },

    async activeScopes(appId) {
      const keys = await db.query<{ scope: ApiKeyScope }>(
        'SELECT DISTINCT scope FROM api_keys WHERE app_id = $1 AND revoked_at IS NULL',
        [appId],
      );
      return keys.rows.map((r) => r.scope);
    },

    async list(appId) {
      const res = await db.query<ApiKeyListing>(
        `SELECT id::text, scope, label, created_at AS "createdAt", last_used_at AS "lastUsedAt", revoked_at AS "revokedAt"
           FROM api_keys WHERE app_id = $1 ORDER BY created_at DESC`,
        [appId],
      );
      return res.rows;
    },

    async create(key) {
      const res = await db.query<{ id: string }>(
        'INSERT INTO api_keys (app_id, scope, sha256, label) VALUES ($1, $2, $3, $4) RETURNING id::text',
        [key.appId, key.scope, key.sha256, key.label],
      );
      return res.rows[0]!.id;
    },

    async revoke(appId, id) {
      const res = await db.query(
        'UPDATE api_keys SET revoked_at = now() WHERE app_id = $1 AND id = $2 AND revoked_at IS NULL',
        [appId, id],
      );
      return Boolean(res.rowCount);
    },

    async ensureFromEnvironment(key) {
      await db.query(
        `WITH added AS (
           INSERT INTO api_keys (app_id, scope, sha256, label) VALUES ($1, $2, $3, $4)
           ON CONFLICT (sha256) DO NOTHING RETURNING id
         ), replaced AS (
           UPDATE api_keys SET revoked_at = now()
            WHERE EXISTS (SELECT 1 FROM added) AND app_id = $1 AND scope = $2 AND label = $4 AND sha256 <> $3
              AND revoked_at IS NULL
           RETURNING id
         ), signed_out AS (
           DELETE FROM sessions WHERE key_id IN (SELECT id FROM replaced)
         )
         INSERT INTO admin_audit (app_id, action, details)
         SELECT $1, 'key_revoke', jsonb_build_object('id', id::text, 'by', 'environment', 'variable', $4::text)
           FROM replaced`,
        [key.appId, key.scope, key.sha256, key.label],
      );
    },
  };
}
