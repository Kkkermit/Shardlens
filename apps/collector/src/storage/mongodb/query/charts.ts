import type { QueryStorage } from '../../store.js';
import type { Mongo } from '../connect.js';
import { pendingMethods } from '../pending.js';

export function mongoChartsQueries(_m: Mongo): Pick<QueryStorage, 'series' | 'top' | 'heatmap'> {
  return pendingMethods<Pick<QueryStorage, 'series' | 'top' | 'heatmap'>>('query', ['series', 'top', 'heatmap']);
}
