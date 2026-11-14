/**
 * Latency histograms: 40 log-scale buckets covering 1 ms to 60 s. They merge by element-wise addition, so percentiles
 * survive rollups. `HISTOGRAM_BUCKETS` in `@shardlens/schema` and the collector's SQL `shardlens_bucket()` must match.
 */

export const BUCKETS = 40;

/** Larger durations land in the last bucket. */
export const MAX_MS = 60_000;

const LOG_MAX = Math.log(MAX_MS);

export type Histogram = number[];

export function newHistogram(): Histogram {
  return new Array<number>(BUCKETS).fill(0);
}

/** Bucket index for a duration. Anything at or below 1 ms, or not a number, goes to bucket 0. */
export function bucketOf(ms: number): number {
  if (!(ms > 1)) return 0;
  const i = Math.floor((Math.log(ms) / LOG_MAX) * (BUCKETS - 1));
  return Math.min(BUCKETS - 1, Math.max(0, i));
}

export function bucketUpperMs(i: number): number {
  return Math.exp(((i + 1) / (BUCKETS - 1)) * LOG_MAX);
}

export function observe(hist: Histogram, ms: number, weight = 1): void {
  const i = bucketOf(ms);
  hist[i] = (hist[i] ?? 0) + weight;
}

export function mergeHistograms(a: readonly number[], b: readonly number[]): Histogram {
  const out = newHistogram();
  for (let i = 0; i < BUCKETS; i++) out[i] = (a[i] ?? 0) + (b[i] ?? 0);
  return out;
}

/** Estimated quantile (`q` in 0–1): the upper bound of the bucket where the cumulative share first reaches `q`. */
export function quantile(hist: readonly number[], q: number): number | undefined {
  if (!(q >= 0 && q <= 1)) throw new RangeError(`quantile must be between 0 and 1, got ${q}`);
  const total = hist.reduce((a, b) => a + b, 0);
  if (total === 0) return undefined;
  let seen = 0;
  for (let i = 0; i < hist.length; i++) {
    seen += hist[i]!;
    if (seen > 0 && seen / total >= q) return bucketUpperMs(i);
  }
  return bucketUpperMs(hist.length - 1);
}
