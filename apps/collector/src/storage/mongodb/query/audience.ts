import type { QueryStorage } from '../../store.js';
import type { Mongo } from '../connect.js';
import { pendingMethods } from '../pending.js';

export function mongoAudienceQueries(_m: Mongo): Pick<QueryStorage, 'audience'> {
  return pendingMethods<Pick<QueryStorage, 'audience'>>('query', ['audience']);
}
