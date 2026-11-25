import type { Document } from 'mongodb';

/*
 * PostgreSQL keeps event weights as `real`, and `sum()` of a `real` is a `real`: each row's weight is added in float4,
 * rounding at every step (the sum of weights of 1 stops growing at 16,777,216), and a ratio of two such sums is divided
 * in float4 before `::float8` widens it. These give the same figures from counts of rows by weight, so a pipeline
 * groups single events by weight and counts them rather than adding weights up itself. Where rounding happens with
 * more than one weight, PostgreSQL's figure also depends on the order it reads rows in, which no query fixes: rows are
 * added here lightest weight first.
 */

const f32 = Math.fround;
/** Every multiple of a float4's lowest bit up to this many of them is a float4. */
const EXACT_STEPS = 2 ** 24;

/** Events of one weight (a float4, as stored), and how many there are. */
export interface WeightRows {
  w: number;
  n: number;
}

/** The largest power of two `w` is a multiple of. */
function lowestBit(w: number): number {
  let unit = 2 ** Math.floor(Math.log2(w));
  while (w % unit !== 0) unit /= 2;
  return unit;
}

/** `acc` with `n` rows of weight `w` added one at a time in float4. */
function addRows(acc: number, w: number, n: number): number {
  let sum = acc;
  let left = n;
  const unit = lowestBit(w);
  // While every partial sum is a multiple of `unit` below 2^24 of them, none rounds: those steps can be taken at once.
  if (sum % unit === 0) {
    const exact = Math.min(left, Math.floor((EXACT_STEPS * unit - sum) / w));
    if (exact > 0) {
      sum += exact * w;
      left -= exact;
    }
  }
  for (; left > 0; left--) {
    const next = f32(sum + w);
    // The weight no longer moves the sum, so no further row will.
    if (next === sum) break;
    sum = next;
  }
  return sum;
}

/** `sum(weight)` over the rows: `null` when there are none. */
export function realSum(rows: Iterable<WeightRows>): number | null {
  const list = [...rows].filter((r) => r.n > 0).sort((a, b) => a.w - b.w);
  if (list.length === 0) return null;
  let sum = 0;
  for (const r of list) sum = addRows(sum, r.w, r.n);
  return sum;
}

/** `(a / nullif(b, 0))::float8` for two `real` sums: `null` when either is `null`, or `b` is 0. */
export function realRatio(a: number | null, b: number | null): number | null {
  if (a === null || b === null || b === 0) return null;
  return f32(a / b);
}

/** Rows of one weight, `_id`, and how many of them count towards each figure. */
export type CountsByWeight<F extends string> = { _id: number } & { [K in F]: number };

/** `sum(weight)` of the rows counted under `figure`: `null` when none are. */
export function realSumOf<F extends string>(groups: readonly CountsByWeight<F>[], figure: F): number | null {
  return realSum(groups.map((g) => ({ w: g._id, n: g[figure] })));
}

/** A key and its rows by weight, as {@link weightsBy} groups them. */
export interface KeyWeights<K> {
  _id: K;
  weights: WeightRows[];
}

/**
 * Stages that group rows by `key`, most weight first (ties by key), at most `limit` keys, each with its rows by weight.
 * Keys are ordered and cut by their weight added in double precision: the `real` sums {@link summed} works out can only
 * tie or swap keys within float4 rounding of each other, whose order PostgreSQL leaves open as well.
 */
export function weightsBy(key: unknown, limit?: number): Document[] {
  return [
    { $group: { _id: { k: key, w: '$weight' }, n: { $sum: 1 } } },
    {
      $group: {
        _id: '$_id.k',
        weights: { $push: { w: '$_id.w', n: '$n' } },
        approx: { $sum: { $multiply: ['$_id.w', '$n'] } },
      },
    },
    { $sort: { approx: -1, _id: 1 } },
    ...(limit === undefined ? [] : [{ $limit: limit }]),
  ];
}

/** Each key's `sum(weight)`, most first, keys with equal sums in the order they came. */
export function summed<K>(rows: readonly KeyWeights<K>[]): { key: K; value: number }[] {
  return rows.map((r) => ({ key: r._id, value: realSum(r.weights) ?? 0 })).sort((a, b) => b.value - a.value);
}
