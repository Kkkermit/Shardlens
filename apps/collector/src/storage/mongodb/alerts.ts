import type { AlertStorage } from '../store.js';
import type { Mongo } from './connect.js';
import { pending } from './pending.js';

export function mongoAlerts(_m: Mongo): AlertStorage {
  return pending<AlertStorage>('alerts');
}
