import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { BUCKETS, bucketOf, bucketUpperMs, mergeHistograms, newHistogram, observe, quantile } from '../src/index.js';

describe('histogram', () => {
  it('has 40 buckets covering 1 ms .. 60 s', () => {
    expect(BUCKETS).toBe(40);
    expect(bucketOf(0)).toBe(0);
    expect(bucketOf(1)).toBe(0);
    expect(bucketOf(60_000)).toBe(39);
    expect(bucketOf(10_000_000)).toBe(39);
    expect(bucketUpperMs(38)).toBeCloseTo(60_000, 6);
  });

  it('puts 120 ms in bucket 16 (matches SQL shardlens_bucket)', () => {
    expect(bucketOf(120)).toBe(16);
  });

  it('sends NaN, negative and infinite values to the edge buckets instead of corrupting the histogram', () => {
    expect(bucketOf(Number.NaN)).toBe(0);
    expect(bucketOf(-5)).toBe(0);
    expect(bucketOf(Number.POSITIVE_INFINITY)).toBe(39);
  });

  it('estimates p50 of [50, 80, 120, 200, 3000] ms as about 121 ms', () => {
    const hist = newHistogram();
    for (const ms of [50, 80, 120, 200, 3000]) observe(hist, ms);
    expect(quantile(hist, 0.5)).toBeCloseTo(121, 0);
  });

  it('returns undefined for an empty histogram and rejects quantiles outside [0, 1]', () => {
    expect(quantile(newHistogram(), 0.95)).toBeUndefined();
    expect(() => quantile(newHistogram(), 1.5)).toThrow(RangeError);
    expect(() => quantile(newHistogram(), Number.NaN)).toThrow(RangeError);
  });

  it('is monotonic: a larger duration never lands in a lower bucket (property)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1e6, noNaN: true }),
        fc.double({ min: 0, max: 1e6, noNaN: true }),
        (a, b) => {
          const [lo, hi] = a <= b ? [a, b] : [b, a];
          expect(bucketOf(lo)).toBeLessThanOrEqual(bucketOf(hi));
        },
      ),
    );
  });

  it('merges associatively and commutatively, preserving totals (property)', () => {
    const hist = fc.array(fc.nat({ max: 1_000_000 }), { minLength: BUCKETS, maxLength: BUCKETS });
    fc.assert(
      fc.property(hist, hist, hist, (a, b, c) => {
        expect(mergeHistograms(mergeHistograms(a, b), c)).toEqual(mergeHistograms(a, mergeHistograms(b, c)));
        expect(mergeHistograms(a, b)).toEqual(mergeHistograms(b, a));
        const sum = (h: number[]) => h.reduce((x, y) => x + y, 0);
        expect(sum(mergeHistograms(a, b))).toBe(sum(a) + sum(b));
      }),
    );
  });
});
