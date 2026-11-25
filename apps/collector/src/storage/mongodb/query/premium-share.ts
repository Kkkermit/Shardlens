import { KIND } from '../../../ingest/codes.js';
import type { Mongo } from '../connect.js';
import { type CountsByWeight, realRatio, realSumOf } from './real-sums.js';

/**
 * Share of runs by users with an entitlement, 0 to 1, from single events: PostgreSQL's
 * `(sum(weight) FILTER (WHERE premium) / nullif(sum(weight), 0))::float8`, so `null` until a premium user has run
 * something. Message commands have no entitlements and are left out.
 */
export async function premiumShare(m: Mongo, appId: string, from: Date, to: Date): Promise<number | null> {
  const runs = await m.c.interactions
    .aggregate<CountsByWeight<'runs' | 'premium'>>([
      { $match: { appId, ts: { $gte: from, $lt: to }, kind: { $ne: KIND.message_command } } },
      { $group: { _id: '$weight', runs: { $sum: 1 }, premium: { $sum: { $cond: ['$premium', 1, 0] } } } },
    ])
    .toArray();
  return realRatio(realSumOf(runs, 'premium'), realSumOf(runs, 'runs'));
}
