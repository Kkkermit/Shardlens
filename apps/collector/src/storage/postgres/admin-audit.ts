import type { Db } from '../../db.js';
import type { AdminAuditStorage } from '../store.js';

export function postgresAdminAudit(db: Db): AdminAuditStorage {
  return {
    async record(appId, userId, action, details = {}) {
      await db.query('INSERT INTO admin_audit (app_id, user_id, action, details) VALUES ($1, $2, $3, $4)', [
        appId,
        userId,
        action,
        JSON.stringify(details),
      ]);
    },
  };
}
