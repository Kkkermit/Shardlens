import type { QueryStorage } from '../../store.js';
import type { Mongo } from '../connect.js';
import { pendingMethods } from '../pending.js';

export function mongoReportsQueries(_m: Mongo): Pick<QueryStorage, 'premium' | 'installs' | 'badge'> {
  return pendingMethods<Pick<QueryStorage, 'premium' | 'installs' | 'badge'>>('query', [
    'premium',
    'installs',
    'badge',
  ]);
}
