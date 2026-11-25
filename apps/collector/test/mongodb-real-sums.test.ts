import { describe, expect, it } from 'vitest';
import { countWhenRan, realRatio, realSum, realSumOf, summed } from '../src/storage/mongodb/query/real-sums.js';

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
    // Unreachable from a validated batch (weights are positive), but must still return.
    expect(realSum([{ w: 0, n: 5 }])).toBe(0);
    expect(realSum([{ w: Number.POSITIVE_INFINITY, n: 3 }])).toBe(Number.POSITIVE_INFINITY);
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

  it('adds up the rows counted under a figure, 0 or null as PostgreSQL tells no match from no rows', () => {
    const groups = [
      { _id: 1, runs: 3, failed: 0 },
      { _id: 2.5, runs: 2, failed: 0 },
    ];
    expect(realSumOf(groups, 'runs')).toBe(8);
    expect(realSumOf(groups, 'failed')).toBeNull();
    expect(countWhenRan(groups, 'failed')).toBe(0);
    expect(countWhenRan<'failed'>([], 'failed')).toBeNull();
  });

  it('orders keys by their real sums, keeping the order they came in for equal ones', () => {
    const third = Math.fround(1 / 0.3);
    expect(
      summed([
        { _id: 'b', weights: [{ w: 1, n: 2 }] },
        { _id: 'c', weights: [{ w: third, n: 7 }] },
        { _id: 'a', weights: [{ w: 2, n: 1 }] },
      ]),
    ).toEqual([
      { key: 'c', value: rowByRow([{ w: third, n: 7 }]) },
      { key: 'b', value: 2 },
      { key: 'a', value: 2 },
    ]);
  });
});
