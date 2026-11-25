import type { AppStorage } from '../store.js';
import type { Mongo } from './connect.js';
import { pending } from './pending.js';

export function mongoApps(_m: Mongo): AppStorage {
  return pending<AppStorage>('apps');
}
