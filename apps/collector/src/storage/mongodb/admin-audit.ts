import type { AdminAuditStorage } from '../store.js';
import type { Mongo } from './connect.js';
import { pending } from './pending.js';

export function mongoAdminAudit(_m: Mongo): AdminAuditStorage {
  return pending<AdminAuditStorage>('adminAudit');
}
