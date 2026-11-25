import { BUCKETS, bucketOf } from '@shardlens/core';
import type { Document } from 'mongodb';

/**
 * The upper bound of each latency bucket as PostgreSQL's `shardlens_hist_quantile` gives it, `exp((i + 1) / 39 *
 * ln(60000))` with C's libm (glibc and musl agree). V8's `Math.exp`, which `@shardlens/core`'s `bucketUpperMs` uses,
 * differs in the last bit for 7 of the 40, so an answer read from MongoDB would not equal PostgreSQL's.
 */
export const POSTGRES_BUCKET_UPPER_MS: readonly number[] = [
  1.325918098651769, 1.7580588043323218, 2.331041987158314, 3.090770759490393, 4.098108888791984, 5.433756745894982,
  7.204716413053295, 9.55286388772082, 12.66631512268593, 16.79449646439587, 22.268126819885634, 29.525712373559223,
  39.14867641168864, 51.90793859251954, 68.82567524352633, 91.25720845732053, 120.99958432599853, 160.4355387871823,
  212.7243845448728, 282.0551114926054, 373.9819771452883, 495.8694720665098, 657.4823075818829, 871.7676911661482,
  1155.8925595370613, 1532.6188647871065, 2032.1270911563522, 2694.4340889247796, 3572.5989241296575, 4736.973572727354,
  6280.838992914321, 8327.878095422853, 11042.084290086772, 14640.899407064428, 19412.633504366688, 25739.562105933477,
  34128.55124762846, 45251.663779994924, 60000.00000000002, 79555.08591910607,
];

/**
 * Pipeline stages that turn single events into `{ _id: ack ms, w: weight }`, the input of {@link ackQuantile}: one row
 * per distinct duration (whole milliseconds), so the answer stays small whatever the number of events. Each event's
 * weight is rounded half to even first, as `shardlens_hist_one` rounds a `real` with `round()`.
 */
export const ACK_WEIGHTS: Document[] = [
  { $match: { ackMs: { $ne: null } } },
  { $group: { _id: '$ackMs', w: { $sum: { $round: ['$weight', 0] } } } },
];

/**
 * The `q` quantile of the time to first response, as PostgreSQL's
 * `shardlens_hist_quantile(shardlens_hist_sum(shardlens_hist_one(ack_ms, weight)), q)` computes it: the upper bound of
 * the bucket where the cumulative share first reaches `q`. `null` when there is no weight at all.
 */
export function ackQuantile(rows: readonly { _id: number; w: number }[], q: number): number | null {
  const hist = new Array<number>(BUCKETS).fill(0);
  // `shardlens_bucket` matches `bucketOf` for every whole millisecond.
  for (const row of rows) hist[bucketOf(row._id)]! += row.w;
  const total = hist.reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  let seen = 0;
  for (let i = 0; i < BUCKETS; i++) {
    seen += hist[i]!;
    if (seen > 0 && seen / total >= q) return POSTGRES_BUCKET_UPPER_MS[i]!;
  }
  return null;
}
