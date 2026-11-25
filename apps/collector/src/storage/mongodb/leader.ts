import type { JobLeader } from '../store.js';
import type { Mongo } from './connect.js';
import { pending } from './pending.js';

/** A contender for job leadership, on a lease in `shardlens_leases` (no advisory locks on MongoDB). */
export function mongoLeader(_m: Mongo): JobLeader {
  return pending<JobLeader>('jobs.leader()');
}
