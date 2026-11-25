import { KIND } from '../../../ingest/codes.js';
import type { Mongo } from '../connect.js';
import { realRatio, realSum } from './real-sums.js';

/**
 * Share of runs by users with an entitlement, 0 to 1, from single events: PostgreSQL's
 * `(sum(weight) FILTER (WHERE premium) / nullif(sum(weight), 0))::float8`, so `null` until a premium user has run
 * something. Message commands have no entitlements and are left out.
 */
export async function premiumShare(m: Mongo, appId: string, from: Date, to: Date): Promise<number | null> {
  const rows = await m.c.interactions
    .aggregate<{ _id: { w: number; premium: boolean }; n: number }>([
      { $match: { appId, ts: { $gte: from, $lt: to }, kind: { $ne: KIND.message_command } } },
      { $group: { _id: { w: '$weight', premium: '$premium' }, n: { $sum: 1 } } },
    ])
    .toArray();
  const weights = (premium?: boolean) =>
    rows.filter((r) => premium === undefined || r._id.premium === premium).map((r) => ({ w: r._id.w, n: r.n }));
  return realRatio(realSum(weights(true)), realSum(weights()));
}
