import type { QueryStorage } from '../../store.js';
import type { Mongo } from '../connect.js';
import { pendingMethods } from '../pending.js';

export function mongoCommandsQueries(_m: Mongo): Pick<QueryStorage, 'commands' | 'command'> {
  return pendingMethods<Pick<QueryStorage, 'commands' | 'command'>>('query', ['commands', 'command']);
}
