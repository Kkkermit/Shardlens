import type { Document } from 'mongodb';

/*
 * PostgreSQL's arithmetic and text where they differ from JavaScript's or MongoDB's, so that answers read from MongoDB
 * equal PostgreSQL's (`postgres/query/`). Sums of event weights, which PostgreSQL adds as `real`, are in
 * `real-sums.ts`.
 */

/** A positive double's exact value as `digits` × 10^−`scale`. */
function exactDecimal(x: number): { digits: bigint; scale: number } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const bits = view.getBigUint64(0);
  const biased = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & 0xf_ffff_ffff_ffffn;
  const mantissa = biased === 0 ? fraction : fraction | (1n << 52n);
  const exponent = (biased === 0 ? 1 : biased) - 1075;
  // m × 2^−k is m × 5^k × 10^−k.
  return exponent >= 0
    ? { digits: mantissa << BigInt(exponent), scale: 0 }
    : { digits: mantissa * 5n ** BigInt(-exponent), scale: -exponent };
}

/**
 * `round(x::numeric, 1)::float8`. A double becomes a numeric with 15 significant digits, as C's `%.15g` prints it
 * (exactly, ties to even: JavaScript's `toPrecision` rounds ties up, and large doubles often sit on a tie); `round`
 * then rounds half away from zero, and the numeric's text reads back as the nearest double.
 */
export function roundTenths(x: number): number {
  if (x === 0 || !Number.isFinite(x)) return x === 0 ? 0 : x;
  let { digits, scale } = exactDecimal(Math.abs(x));
  const drop = digits.toString().length - 15;
  if (drop > 0) {
    const unit = 10n ** BigInt(drop);
    const rest = digits % unit;
    digits /= unit;
    const half = unit / 2n;
    if (rest > half || (rest === half && digits % 2n === 1n)) digits += 1n;
    scale -= drop;
  }
  if (scale > 1) {
    const unit = 10n ** BigInt(scale - 1);
    const rest = digits % unit;
    digits /= unit;
    if (rest * 2n >= unit) digits += 1n;
    scale = 1;
  }
  if (digits === 0n) return 0;
  return Number(`${x < 0 ? '-' : ''}${digits}e${-scale}`);
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
