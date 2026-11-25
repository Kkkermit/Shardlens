import type { Document } from 'mongodb';

/*
 * PostgreSQL's arithmetic and text where they differ from JavaScript's or MongoDB's, so that answers read from MongoDB
 * equal PostgreSQL's (`postgres/query/`). Weights are `real` there, so `sum(weight)` over single events is a `real`,
 * and a share of two such sums a `real` division.
 */

/** `sum(weight)` of single events, a `real`. */
export const real = (sum: number): number => Math.fround(sum);

/** `sum(weight)` of single events, `null` when there were none (`sum` over no rows). */
export const realOrNull = (sum: number, rows: number): number | null => (rows > 0 ? Math.fround(sum) : null);

/**
 * `coalesce(sum(weight) FILTER (…), 0) / nullif(sum(weight) FILTER (…), 0)` (`totals-sql.ts`): a `real` divided by a
 * `real`, `null` when nothing matches `whole`. The double quotient of two `real`s rounded to a `real` is the `real`
 * quotient: a double has more than twice a `real`'s precision.
 */
export function realShare(part: number, whole: number): number | null {
  const of = Math.fround(whole);
  return of === 0 ? null : Math.fround(Math.fround(part) / of);
}

/**
 * `round(x::numeric, 1)::float8`: a double becomes a numeric with 15 significant digits (`%.15g`), which `round`
 * rounds half away from zero.
 */
export function roundTenths(x: number): number {
  if (x === 0 || !Number.isFinite(x)) return x === 0 ? 0 : x;
  const [mantissa = '0', exponent = '0'] = Math.abs(x).toExponential(14).split('e');
  const digits = BigInt(mantissa.replace('.', ''));
  // `digits` × 10^(e − 14) is the numeric; its tenths are `digits` × 10^(e − 13).
  const drop = 13 - Number(exponent);
  let tenths: bigint;
  if (drop <= 0) tenths = digits * 10n ** BigInt(-drop);
  else if (drop > 15) tenths = 0n;
  else {
    tenths = digits / 10n ** BigInt(drop);
    if ((digits / 10n ** BigInt(drop - 1)) % 10n >= 5n) tenths += 1n;
  }
  if (tenths === 0n) return 0;
  const value = Number(tenths) / 10;
  return x < 0 ? -value : value;
}

/** `percentile_cont` between two neighbouring values: PostgreSQL interpolates as `lo + fraction × (hi − lo)`. */
export const interpolate = (lo: number, hi: number, fraction: number): number => lo + fraction * (hi - lo);

/**
 * Text in PostgreSQL's order under a byte-order collation: `C`, or any locale of Alpine's musl, which the collector's
 * images and tests run. MongoDB compares strings the same way. A glibc locale orders some text otherwise (`B` and `a`).
 */
export const byteOrder = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

const zeros = (n: unknown) => ({
  $reduce: { input: { $range: [0, n] }, initialValue: '', in: { $concat: ['$$value', '0'] } },
});

/**
 * A double as `jsonb` prints a number: the shortest digits that read back as the double (JavaScript's, which wrote the
 * JSON, and MongoDB's agree), never in exponent form (`1e+21` is `1000000000000000000000`, `1e-7` is `0.0000001`), and
 * `0` for `-0`, which JSON can't carry. MongoDB writes exponents for more numbers than JavaScript does (`1e+16`,
 * `1e-06`), which are written out here.
 */
function plainNumber(double: string): Document {
  const parts = /^(-?)(\d)(?:\.(\d+))?e([+-])(\d+)$/.source;
  return {
    $let: {
      vars: { s: { $toString: double } },
      in: {
        $cond: [
          { $eq: [double, 0] },
          '0',
          {
            $let: {
              vars: { m: { $regexFind: { input: '$$s', regex: parts } } },
              in: {
                $cond: [
                  { $eq: ['$$m', null] },
                  '$$s',
                  {
                    $let: {
                      vars: {
                        sign: { $arrayElemAt: ['$$m.captures', 0] },
                        lead: { $arrayElemAt: ['$$m.captures', 1] },
                        rest: { $ifNull: [{ $arrayElemAt: ['$$m.captures', 2] }, ''] },
                        down: { $eq: [{ $arrayElemAt: ['$$m.captures', 3] }, '-'] },
                        e: { $toInt: { $arrayElemAt: ['$$m.captures', 4] } },
                      },
                      in: {
                        $concat: [
                          '$$sign',
                          {
                            $cond: [
                              '$$down',
                              { $concat: ['0.', zeros({ $subtract: ['$$e', 1] }), '$$lead', '$$rest'] },
                              // A double this large is a whole number: its digits never reach past the exponent.
                              { $concat: ['$$lead', '$$rest', zeros({ $subtract: ['$$e', { $strLenCP: '$$rest' }] })] },
                            ],
                          },
                        ],
                      },
                    },
                  },
                ],
              },
            },
          },
        ],
      },
    },
  };
}

/**
 * A JSON value (option values, custom event properties) as text, the way PostgreSQL's `->>` and `jsonb_each_text` give
 * it: strings as they are, `true` and `false`, numbers as `jsonb` prints them, and `null` for JSON null or no value.
 */
export function jsonText(value: unknown): Document {
  const byType: [string[], unknown][] = [
    [['string'], '$$v'],
    [['bool'], { $cond: ['$$v', 'true', 'false'] }],
    [['int', 'long'], { $toString: '$$v' }],
    [['double'], plainNumber('$$v')],
  ];
  return {
    $let: {
      vars: { v: value, type: { $type: value } },
      in: byType.reduceRight<unknown>(
        (otherwise, [types, text]) => ({ $cond: [{ $in: ['$$type', types] }, text, otherwise] }),
        null,
      ),
    },
  };
}
