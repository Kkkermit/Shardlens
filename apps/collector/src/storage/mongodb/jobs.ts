import type { JobStorage } from '../store.js';
import type { Mongo } from './connect.js';
import { pending } from './pending.js';

export function mongoJobs(_m: Mongo): JobStorage {
  return pending<JobStorage>('jobs');
}
