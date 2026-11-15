import { describe, expect, it } from 'vitest';
import { periodLabel, UserHasher } from '../src/index.js';

const NOV_13 = new Date('2026-11-13T16:42:01Z');
const SALT = Uint8Array.from({ length: 32 }, (_, i) => i);
const OTHER_SALT = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);

describe('periodLabel', () => {
  it('labels 13 Nov 2026 as month 2026-11, ISO week 2026-W46 and day 2026-11-13', () => {
    expect(periodLabel('month', NOV_13)).toBe('2026-11');
    expect(periodLabel('week', NOV_13)).toBe('2026-W46');
    expect(periodLabel('day', NOV_13)).toBe('2026-11-13');
  });

  it('uses ISO week-numbering years at year boundaries', () => {
    expect(periodLabel('week', new Date('2026-01-01T00:00:00Z'))).toBe('2026-W01'); // Thursday
    expect(periodLabel('week', new Date('2027-01-01T00:00:00Z'))).toBe('2026-W53'); // Friday
    expect(periodLabel('week', new Date('2024-12-30T00:00:00Z'))).toBe('2025-W01'); // Monday
    expect(periodLabel('week', new Date('2021-01-03T23:59:59Z'))).toBe('2020-W53'); // Sunday
  });

  it('always uses UTC', () => {
    expect(periodLabel('day', new Date('2026-11-30T23:59:59.999Z'))).toBe('2026-11-30');
    expect(periodLabel('month', new Date('2026-12-01T00:00:00.000Z'))).toBe('2026-12');
  });
});

describe('UserHasher', () => {
  it('produces h1:<period>:<32 hex> from HMAC-SHA-256 truncated to 16 bytes', async () => {
    const hasher = new UserHasher();
    await hasher.setSalt('2026-11', SALT);
    // Known answer computed independently with node:crypto createHmac('sha256', salt).
    expect(await hasher.hash('112233445566778899', '2026-11')).toBe('h1:2026-11:5d709cc09774e861e96e3d124cf1945e');
  });

  it('is deterministic within a period and differs across salts', async () => {
    const a = new UserHasher();
    await a.setSalt('2026-11', SALT);
    await a.setSalt('2026-12', OTHER_SALT);
    const first = await a.hash('112233445566778899', '2026-11');
    expect(await a.hash('112233445566778899', '2026-11')).toBe(first);
    const other = await a.hash('112233445566778899', '2026-12');
    expect(other?.slice(-32)).not.toBe(first?.slice(-32));
    expect(await a.hash('223344556677889900', '2026-11')).not.toBe(first);
  });

  it('returns undefined when no salt is installed for the period', async () => {
    const hasher = new UserHasher();
    expect(await hasher.hash('112233445566778899', '2026-11')).toBeUndefined();
    expect(hasher.hasSalt('2026-11')).toBe(false);
  });

  it('keeps only the three most recent periods', async () => {
    const hasher = new UserHasher();
    for (const label of ['2026-09', '2026-10', '2026-11', '2026-12']) await hasher.setSalt(label, SALT);
    expect(hasher.hasSalt('2026-09')).toBe(false);
    expect(hasher.labels()).toEqual(['2026-10', '2026-11', '2026-12']);
  });

  it("keeps the next period's salt, which the collector sends just before a boundary", async () => {
    const hasher = new UserHasher();
    // The collector lists the current, previous and next salts; the SDK installs them in reverse.
    for (const label of ['2026-12', '2026-10', '2026-11']) await hasher.setSalt(label, SALT);
    for (const label of ['2026-10', '2026-11', '2026-12']) expect(await hasher.hash('42', label)).toMatch(/^h1:/);
  });

  it('never serves a cached hash after the salt changes', async () => {
    const hasher = new UserHasher();
    await hasher.setSalt('2026-11', SALT);
    const first = await hasher.hash('112233445566778899', '2026-11');
    expect(await hasher.hash('112233445566778899', '2026-11')).toBe(first); // cached
    await hasher.setSalt('2026-11', OTHER_SALT);
    expect(await hasher.hash('112233445566778899', '2026-11')).not.toBe(first);
  });

  it('forgets a deleted salt and every hash made with it', async () => {
    const hasher = new UserHasher();
    await hasher.setSalt('2026-10', SALT);
    await hasher.setSalt('2026-11', SALT);
    expect(await hasher.hash('112233445566778899', '2026-10')).toMatch(/^h1:/); // cached
    hasher.deleteSalt('2026-10');
    hasher.deleteSalt('2026-09'); // never installed: nothing happens
    expect(hasher.labels()).toEqual(['2026-11']);
    expect(await hasher.hash('112233445566778899', '2026-10')).toBeUndefined();
  });

  it('treats re-installing a period as the most recent', async () => {
    const hasher = new UserHasher();
    await hasher.setSalt('2026-10', SALT);
    await hasher.setSalt('2026-11', SALT);
    await hasher.setSalt('2026-10', OTHER_SALT);
    await hasher.setSalt('2026-12', SALT);
    await hasher.setSalt('2027-01', SALT);
    expect(hasher.hasSalt('2026-10')).toBe(true);
    expect(hasher.hasSalt('2026-11')).toBe(false);
  });
});
