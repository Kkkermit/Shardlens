import type { JobStorage } from '../store.js';
import type { Mongo } from './connect.js';
import { prepareIndexes } from './indexes.js';
import { mongoLeader } from './leader.js';
import { runRetention } from './retention.js';
import { backfillRollups, runRollups } from './rollups.js';
import { runUniques } from './uniques.js';

export function mongoJobs(m: Mongo): JobStorage {
  return {
    leader: () => mongoLeader(m),
    runRollups: (now, opts) => runRollups(m, now, opts),
    backfillRollups: (from, to, now) => backfillRollups(m, from, to, now),
    runUniques: (appId, period, final) => runUniques(m, appId, period, final),
    // Nothing is made ahead of time on MongoDB: the hourly job only checks the indexes were made for this layout.
    ensurePartitions: () => prepareIndexes(m),
    runRetention: (now) => runRetention(m, now),
  };
}
