import type { QueryStorage } from '../../store.js';
import type { Mongo } from '../connect.js';
import { pendingMethods } from '../pending.js';

export function mongoFunnelsQueries(_m: Mongo): Pick<QueryStorage, 'events' | 'eventProps' | 'funnel' | 'retention'> {
  return pendingMethods<Pick<QueryStorage, 'events' | 'eventProps' | 'funnel' | 'retention'>>('query', [
    'events',
    'eventProps',
    'funnel',
    'retention',
  ]);
}
