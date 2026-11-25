import type { QueryStorage } from '../../store.js';
import type { Mongo } from '../connect.js';
import { pendingMethods } from '../pending.js';

export function mongoHealthQueries(_m: Mongo): Pick<QueryStorage, 'gauge' | 'bursts' | 'reliability'> {
  return pendingMethods<Pick<QueryStorage, 'gauge' | 'bursts' | 'reliability'>>('query', [
    'gauge',
    'bursts',
    'reliability',
  ]);
}
