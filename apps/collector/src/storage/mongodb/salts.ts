import type { SaltStorage } from '../store.js';
import type { Mongo } from './connect.js';
import { pending } from './pending.js';

export function mongoSalts(_m: Mongo): SaltStorage {
  return pending<SaltStorage>('salts');
}
