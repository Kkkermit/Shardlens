import type { QueryStorage } from '../../store.js';
import type { Mongo } from '../connect.js';
import { pendingMethods } from '../pending.js';

export function mongoServersQueries(_m: Mongo): Pick<QueryStorage, 'servers' | 'server' | 'growth' | 'guildNames'> {
  return pendingMethods<Pick<QueryStorage, 'servers' | 'server' | 'growth' | 'guildNames'>>('query', [
    'servers',
    'server',
    'growth',
    'guildNames',
  ]);
}
