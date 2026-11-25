import { ObjectId } from 'mongodb';
import type { AdminAuditStorage } from '../store.js';
import type { Mongo } from './connect.js';
import { asJson } from './json.js';

export function mongoAdminAudit({ c }: Mongo): AdminAuditStorage {
  return {
    async record(appId, userId, action, details = {}) {
      await c.adminAudit.insertOne({
        _id: new ObjectId(),
        ts: new Date(),
        appId,
        ...(userId !== null && { userId }),
        action,
        details: asJson(details),
      });
    },
  };
}
