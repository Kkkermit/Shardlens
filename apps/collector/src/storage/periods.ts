import { nextPeriodStart, periodLabel, type SaltPeriod } from '@shardlens/core';

export type { SaltPeriod };
export { periodLabel };

const MONTH = /^(\d{4})-(\d{2})$/;
const WEEK = /^(\d{4})-W(\d{2})$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Grace period after a salt period ends before its salt is destroyed. */
export const SALT_GRACE_MS = 7 * 86_400_000;

/** Start (inclusive) and end (exclusive) of a salt period, in epoch ms. Returns `undefined` for malformed labels. */
export function periodBounds(label: string): { start: number; end: number; period: SaltPeriod } | undefined {
  let m = MONTH.exec(label);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    if (mo < 1 || mo > 12) return undefined;
    return { start: Date.UTC(y, mo - 1, 1), end: Date.UTC(y, mo, 1), period: 'month' };
  }
  m = DAY.exec(label);
  if (m) {
    const start = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (periodLabel('day', new Date(start)) !== label) return undefined;
    return { start, end: start + 86_400_000, period: 'day' };
  }
  m = WEEK.exec(label);
  if (m) {
    const isoYear = Number(m[1]);
    const week = Number(m[2]);
    if (week < 1 || week > 53) return undefined;
    const jan4 = new Date(Date.UTC(isoYear, 0, 4));
    const mondayOfWeek1 = Date.UTC(isoYear, 0, 4 - ((jan4.getUTCDay() || 7) - 1));
    const start = mondayOfWeek1 + (week - 1) * 7 * 86_400_000;
    if (periodLabel('week', new Date(start)) !== label) return undefined;
    return { start, end: start + 7 * 86_400_000, period: 'week' };
  }
  return undefined;
}

export function previousPeriodLabel(period: SaltPeriod, at: Date): string {
  const label = periodLabel(period, at);
  const bounds = periodBounds(label);
  return periodLabel(period, new Date((bounds?.start ?? at.getTime()) - 1));
}

export function nextPeriodLabel(period: SaltPeriod, at: Date): string {
  return periodLabel(period, new Date(nextPeriodStart(period, at)));
}

/** Safe identifier suffix for a period label (`2026-W46` → `2026_w46`). */
export function periodIdent(label: string): string {
  if (!periodBounds(label)) throw new Error('invalid period label');
  return label.replace(/-/g, '_').toLowerCase();
}
