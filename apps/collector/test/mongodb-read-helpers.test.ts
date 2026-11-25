import { describe, expect, it } from 'vitest';
import { POSTGRES_BUCKET_UPPER_MS } from '../src/storage/mongodb/histogram.js';
import { histQuantile } from '../src/storage/mongodb/query/bucket-quantile.js';
import { realRatio, realSum } from '../src/storage/mongodb/query/real-sums.js';
import { offsetPieces } from '../src/storage/mongodb/query/wall-clock.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** PostgreSQL's `sum()` of a `real` column, a row at a time. */
function rowByRow(rows: { w: number; n: number }[]): number | null {
  let sum: number | null = null;
  for (const { w, n } of rows) for (let i = 0; i < n; i++) sum = Math.fround((sum ?? 0) + w);
  return sum;
}

describe('sums of weights, as PostgreSQL adds a real column', () => {
  it('is null for no rows, and exact while nothing rounds', () => {
    expect(realSum([])).toBeNull();
    expect(realSum([{ w: 1, n: 0 }])).toBeNull();
    expect(realSum([{ w: 1, n: 12_345 }])).toBe(12_345);
    expect(
      realSum([
        { w: 0.5, n: 3 },
        { w: 2, n: 4 },
      ]),
    ).toBe(9.5);
  });

  it('stops growing at 16,777,216 for weights of 1, as `sum(1::real)` does over 20 million rows', () => {
    expect(realSum([{ w: 1, n: 20_000_000 }])).toBe(16_777_216);
    expect(realSum([{ w: 2, n: 20_000_000 }])).toBe(33_554_432);
  });

  it('rounds at every row for a weight no power of two divides', () => {
    const third = Math.fround(1 / 0.3);
    for (const rows of [
      [{ w: third, n: 1 }],
      [{ w: third, n: 7 }],
      [{ w: third, n: 100_003 }],
      [{ w: Math.fround(1.1), n: 50_000 }],
      [
        { w: 1, n: 16_777_000 },
        { w: 3, n: 500 },
      ],
      [
        { w: 0.5, n: 1_000 },
        { w: third, n: 1_000 },
        { w: 10, n: 1_000 },
      ],
    ]) {
      expect(realSum(rows), JSON.stringify(rows)).toBe(rowByRow([...rows].sort((a, b) => a.w - b.w)));
    }
  });

  it('divides two sums in float4', () => {
    expect(realRatio(1, 3)).toBe(0.3333333432674408);
    expect(realRatio(0, 4)).toBe(0);
    expect(realRatio(1, 0)).toBeNull();
    expect(realRatio(1, null)).toBeNull();
    expect(realRatio(null, 2)).toBeNull();
  });
});

describe('time zone offsets over a range', () => {
  const pieces = (zone: string, from: string, to: string) =>
    offsetPieces(zone, Date.parse(from), Date.parse(to)).map((p) => [
      Number.isFinite(p.start) ? new Date(p.start).toISOString() : null,
      p.offset / 60_000,
    ]);

  it('finds each change to the second, in zones that move by an hour or by half an hour', () => {
    expect(pieces('America/New_York', '2026-01-01T00:00:00Z', '2026-12-31T00:00:00Z')).toEqual([
      [null, -300],
      ['2026-03-08T07:00:00.000Z', -240],
      ['2026-11-01T06:00:00.000Z', -300],
    ]);
    expect(pieces('Europe/London', '2026-03-29T00:59:59Z', '2026-03-29T01:00:01Z')).toEqual([
      [null, 0],
      ['2026-03-29T01:00:00.000Z', 60],
    ]);
    expect(pieces('Australia/Lord_Howe', '2026-01-01T00:00:00Z', '2026-12-31T00:00:00Z')).toEqual([
      [null, 660],
      ['2026-04-04T15:00:00.000Z', 630],
      ['2026-10-03T15:30:00.000Z', 660],
    ]);
  });

  it('keeps one offset where the clocks never change', () => {
    expect(pieces('Asia/Kolkata', '2025-11-01T00:00:00Z', '2026-12-01T00:00:00Z')).toEqual([[null, 330]]);
    expect(offsetPieces('UTC', 0, 400 * DAY)).toEqual([{ start: -Infinity, offset: 0 }]);
  });
});

describe('quantiles of a rollup histogram', () => {
  it('is the upper bound of the bucket where the share is reached, and null without counts', () => {
    const hist = new Array<number>(40).fill(0);
    expect(histQuantile(undefined, 0.5)).toBeNull();
    expect(histQuantile(hist, 0.5)).toBeNull();
    hist[3] = 1;
    hist[20] = 3;
    expect(histQuantile(hist, 0)).toBe(POSTGRES_BUCKET_UPPER_MS[3]);
    expect(histQuantile(hist, 0.25)).toBe(POSTGRES_BUCKET_UPPER_MS[3]);
    expect(histQuantile(hist, 0.26)).toBe(POSTGRES_BUCKET_UPPER_MS[20]);
    expect(histQuantile(hist, 1)).toBe(POSTGRES_BUCKET_UPPER_MS[20]);
  });
});
