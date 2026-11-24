import type { Db } from '../../db.js';
import type { SessionMethod, SessionStorage } from '../store.js';

export function postgresSessions(db: Db): SessionStorage {
  return {
    async create(session) {
      await db.query(
        'INSERT INTO sessions (id_sha256, user_id, app_id, method, key_id, expires_at) VALUES ($1, $2, $3, $4, $5, $6)',
        [session.idSha256, session.userId, session.appId, session.method, session.keyId, session.expiresAt],
      );
    },

    async find(idSha256) {
      // Revoking a key deletes its sessions; the join also covers a session read while that runs.
      const res = await db.query<{ app_id: string; user_id: string | null; method: SessionMethod }>(
        `SELECT s.app_id, s.user_id, s.method FROM sessions s LEFT JOIN api_keys k ON k.id = s.key_id
          WHERE s.id_sha256 = $1 AND s.expires_at > now() AND (s.key_id IS NULL OR k.revoked_at IS NULL)`,
        [idSha256],
      );
      const row = res.rows[0];
      return row && { appId: row.app_id, userId: row.user_id, method: row.method };
    },

    async delete(idSha256) {
      await db.query('DELETE FROM sessions WHERE id_sha256 = $1', [idSha256]);
    },

    async deleteForKey(keyId) {
      await db.query('DELETE FROM sessions WHERE key_id = $1', [keyId]);
    },
  };
}
