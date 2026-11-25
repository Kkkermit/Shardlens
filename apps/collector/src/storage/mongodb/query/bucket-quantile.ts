import { POSTGRES_BUCKET_UPPER_MS } from '../histogram.js';

/**
 * PostgreSQL's `shardlens_hist_quantile(h, q)` on a histogram already added up (a rollup's `hist`, summed over
 * documents): the upper bound of the bucket where the cumulative share first reaches `q`. `null` for no histogram, or
 * one that is all zeros.
 */
export function histQuantile(hist: readonly number[] | null | undefined, q: number): number | null {
  if (!hist) return null;
  const total = hist.reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  let seen = 0;
  for (let i = 0; i < hist.length; i++) {
    seen += hist[i]!;
    if (seen > 0 && seen / total >= q) return POSTGRES_BUCKET_UPPER_MS[i] ?? null;
  }
  return null;
}
