import type { KeyStorage } from '../store.js';
import type { Mongo } from './connect.js';
import { pending } from './pending.js';

export function mongoKeys(_m: Mongo): KeyStorage {
  return pending<KeyStorage>('keys');
}
