import type { QueryStorage } from '../../store.js';
import type { Mongo } from '../connect.js';
import { pendingMethods } from '../pending.js';

export function mongoOverviewQueries(_m: Mongo): Pick<QueryStorage, 'overview'> {
  return pendingMethods<Pick<QueryStorage, 'overview'>>('query', ['overview']);
}
