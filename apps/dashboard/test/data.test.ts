import { describe, expect, it } from 'vitest';
import { formatX, pivot } from '../src/chart-data';
import { label, ms, num, pct } from '../src/format';

describe('pivot', () => {
  it('aligns grouped points on a shared x axis, filling gaps with zero', () => {
    const { x, series } = pivot(
      [
        { t: '2026-11-01T00:00:00', key: 'open', value: 3 },
        { t: '2026-11-01T00:00:00', key: 'close', value: 1 },
        { t: '2026-11-02T00:00:00', key: 'open', value: 5 },
      ],
      (k) => `/ticket ${k}`,
    );
    expect(x).toEqual([Date.UTC(2026, 10, 1) / 1000, Date.UTC(2026, 10, 2) / 1000]);
    expect(series).toEqual([
      { name: '/ticket open', values: [3, 5] },
      { name: '/ticket close', values: [1, 0] },
    ]);
  });

  it('formats x values as the wall-clock time they stand for', () => {
    expect(formatX(Date.UTC(2026, 10, 13, 16, 5) / 1000, true)).toBe('2026-11-13 16:05');
    expect(formatX(Date.UTC(2026, 10, 13) / 1000, false)).toBe('2026-11-13');
  });
});

describe('format', () => {
  it('formats numbers, percentages and durations, with a dash for missing values', () => {
    expect(num(null)).toBe('—');
    expect(pct(0.0423)).toBe('4.2%');
    expect(ms(412)).toBe('412 ms');
    expect(ms(3_250)).toBe('3.3 s');
    expect(ms(undefined)).toBe('—');
  });

  it('labels coded dimensions in plain words', () => {
    expect(label('outcome', 'timeout')).toBe('Missed 3 s deadline');
    expect(label('context', '1')).toBe('Bot DM');
    expect(label('channel', '11')).toBe('Public thread or forum post');
    expect(label('locale', 'en-GB')).toBe('en-GB');
    expect(label('install', null)).toBe('(none)');
  });
});
