import type { QueryStorage } from '../store.js';
import type { Mongo } from './connect.js';
import { pending } from './pending.js';

export function mongoQuery(_m: Mongo): QueryStorage {
  return pending<QueryStorage>('query');
}
