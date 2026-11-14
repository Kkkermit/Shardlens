import { describe, expect, it } from 'vitest';
import { BACKOFF_MAX_MS, backoffMs, gzipJson, isAllowedEndpoint, uuidv7, uuidv7Timestamp } from '../src/index.js';

describe('gzipJson', () => {
  it('produces gzip output that round-trips', async () => {
    const value = { v: 1, events: [{ id: 'x', n: 42 }] };
    const gz = await gzipJson(value);
    expect([gz[0], gz[1]]).toEqual([0x1f, 0x8b]);
    const text = await new Response(
      new Blob([gz as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('gzip')),
    ).text();
    expect(JSON.parse(text)).toEqual(value);
  });
});

describe('backoffMs', () => {
  it('uses equal jitter between half and all of the exponential delay', () => {
    expect(backoffMs(0, () => 0)).toBe(500);
    expect(backoffMs(0, () => 0.999999)).toBe(1000);
    expect(backoffMs(3, () => 0)).toBe(4000);
    expect(backoffMs(3, () => 0.999999)).toBe(8000);
  });

  it('caps at 60 seconds', () => {
    expect(backoffMs(50, () => 0.999999)).toBe(BACKOFF_MAX_MS);
    expect(backoffMs(1000, () => 0.5)).toBeLessThanOrEqual(BACKOFF_MAX_MS);
  });
});

describe('isAllowedEndpoint', () => {
  it('allows HTTPS anywhere and HTTP only to loopback', () => {
    expect(isAllowedEndpoint('https://stats.example.com')).toBe(true);
    expect(isAllowedEndpoint('http://localhost:8080')).toBe(true);
    expect(isAllowedEndpoint('http://127.0.0.1:8080')).toBe(true);
    expect(isAllowedEndpoint('http://[::1]:8080')).toBe(true);
    expect(isAllowedEndpoint('http://stats.example.com')).toBe(false);
    expect(isAllowedEndpoint('http://localhost.example.com')).toBe(false);
    expect(isAllowedEndpoint('ftp://stats.example.com')).toBe(false);
    expect(isAllowedEndpoint('not a url')).toBe(false);
  });

  it('refuses URLs with embedded credentials', () => {
    expect(isAllowedEndpoint('https://user:pass@stats.example.com')).toBe(false);
  });
});

describe('uuidv7', () => {
  it('formats an RFC 9562 version 7, variant 10 UUID', () => {
    const id = uuidv7();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('encodes the timestamp so IDs sort by time', () => {
    const t = Date.UTC(2026, 10, 13, 16, 42, 1, 234);
    expect(uuidv7Timestamp(uuidv7(t))).toBe(t);
    expect(uuidv7(t) < uuidv7(t + 1)).toBe(true);
  });

  it('is unique across many calls in the same millisecond', () => {
    const t = Date.now();
    const ids = new Set(Array.from({ length: 10_000 }, () => uuidv7(t)));
    expect(ids.size).toBe(10_000);
  });
});
