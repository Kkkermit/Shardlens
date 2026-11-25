import type { ReportStorage } from '../store.js';
import type { Mongo } from './connect.js';
import { pending } from './pending.js';

export function mongoReports(_m: Mongo): ReportStorage {
  return pending<ReportStorage>('reports');
}
