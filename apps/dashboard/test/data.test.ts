import { describe, expect, it } from 'vitest';
import { formatX, pivot, timeAxisLabels, weekdayNames, xRange } from '../src/chart-data';
import { ago, agoHour, commandLabel, date, dateTime, day, label, money, ms, num, number, pct } from '../src/format';

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

  it('formats x values as the wall-clock time they stand for, in the locale of the viewer', () => {
    const at = Date.UTC(2026, 10, 13, 16, 5) / 1000;
    expect(formatX(at, true, 'en-GB')).toBe('13 Nov 2026, 16:05');
    expect(formatX(at, true, 'en-US')).toBe('Nov 13, 2026, 4:05 PM');
    expect(formatX(at, false, 'de-DE')).toBe('13.11.2026');
  });
});

describe('time axis labels', () => {
  const hour = 3_600;
  const day = 86_400;

  it('writes hourly ticks as times in the locale, with the date under the first and under each midnight', () => {
    const from = Date.UTC(2026, 10, 14, 18) / 1000;
    const splits = [0, 3, 6, 9].map((h) => from + h * hour);
    expect(timeAxisLabels(splits, 3 * hour, 'en-GB')).toEqual(['18:00\n14 Nov', '21:00', '00:00\n15 Nov', '03:00']);
    expect(timeAxisLabels(splits, 3 * hour, 'en-US')).toEqual([
      '6:00 PM\nNov 14',
      '9:00 PM',
      '12:00 AM\nNov 15',
      '3:00 AM',
    ]);
  });

  it('writes daily ticks as dates, with the year under the first and where it changes', () => {
    const from = Date.UTC(2026, 11, 30) / 1000;
    const splits = [0, 2, 4].map((d) => from + d * day);
    expect(timeAxisLabels(splits, 2 * day, 'de-DE')).toEqual(['30. Dez.\n2026', '1. Jan.\n2027', '3. Jan.']);
    expect(timeAxisLabels(splits, 2 * day, 'en-US')).toEqual(['Dec 30\n2026', 'Jan 1\n2027', 'Jan 3']);
  });

  it('names months for ticks a month or more apart', () => {
    const splits = [Date.UTC(2026, 9, 1), Date.UTC(2026, 10, 1)].map((ms) => ms / 1000);
    expect(timeAxisLabels(splits, 31 * day, 'en-GB')).toEqual(['Oct\n2026', 'Nov']);
  });

  it('names weekdays in the locale, Monday first', () => {
    expect(weekdayNames('en-GB')).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
    expect(weekdayNames('de-DE')[0]).toBe('Mo.');
  });
});

describe('format', () => {
  it('formats numbers, percentages and durations, with a dash for missing values', () => {
    expect(num(null)).toBe('—');
    expect(pct(0.0423)).toBe('4.2%');
    expect(ms(412)).toBe('412 ms');
    expect(ms(3_250)).toBe('3.3 s');
    expect(ms(undefined)).toBe('—');
    expect(num(Number.NaN)).toBe('—');
    expect(pct(Number.POSITIVE_INFINITY)).toBe('—');
  });

  it('formats dates in the given time zone, with a dash for missing or unreadable ones', () => {
    expect(date('2026-11-13T23:30:00Z', 'Asia/Tokyo')).toBe(date('2026-11-14T12:00:00Z', 'UTC'));
    expect(dateTime(null)).toBe('—');
    expect(date('not a date')).toBe('—');
    expect(ago(null)).toBe('never');
    expect(ago('not a date')).toBe('—');
    expect(ago(new Date(Date.now() - 90 * 60_000))).toBe('2h ago');
  });

  it('formats calendar days, thresholds and money in the locale', () => {
    expect(day('2026-11-01', 'en-GB')).toBe('1 Nov 2026');
    expect(day('2026-11-01', 'de-DE')).toBe('01.11.2026');
    expect(day('not a day')).toBe('not a day');
    expect(day(null)).toBe('—');
    expect(number(0.25, 'de-DE')).toBe('0,25');
    expect(number(1_500, 'en-US')).toBe('1,500');
    expect(money(4.99, 'EUR', 'en-GB')).toBe('€4.99');
    // A code Intl refuses is written out rather than breaking the page.
    expect(money(4.99, 'E1', 'en-GB')).toBe('4.99 E1');
  });

  it('labels coded dimensions in plain words', () => {
    expect(label('outcome', 'timeout')).toBe('Missed 3 s deadline');
    expect(label('context', '1')).toBe('Bot DM');
    expect(label('channel', '11')).toBe('Public thread or forum post');
    expect(label('locale', 'en-GB')).toBe('en-GB');
    expect(label('install', null)).toBe('(none)');
  });

  it('writes a slash only in front of slash commands', () => {
    expect(commandLabel('ping', ['chat_input'])).toBe('/ping');
    expect(commandLabel('ban', ['chat_input', 'message_command'])).toBe('/ban');
    expect(commandLabel('roll', ['message_command'])).toBe('roll');
    expect(commandLabel('Profile', ['user_context'])).toBe('Profile');
  });
});

describe('charts with a single bucket', () => {
  it('pad one point by a day either side instead of the ~1,000 days uPlot adds', () => {
    const x = 1_800_000_000;
    expect(xRange([x], x, x + 86_400_000)).toEqual([x - 86_400, x + 86_400]);
    expect(xRange([x, x + 86_400], x, x + 86_400)).toEqual([x, x + 86_400]);
  });
});

describe('agoHour', () => {
  it('says "this hour" for the current hour bucket, and falls back to ago otherwise', () => {
    const hourStart = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);
    expect(agoHour(hourStart)).toBe('this hour');
    expect(agoHour(new Date(Date.now() - 3 * 3_600_000))).toBe('3h ago');
    expect(agoHour(null)).toBe('never');
  });
});
