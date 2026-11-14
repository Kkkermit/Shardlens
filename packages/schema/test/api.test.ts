import { describe, expect, it } from 'vitest';
import { Batch, ConfigResponse, IngestAccepted } from '../src/index.js';
import { batch } from './fixtures.js';

describe('ConfigResponse', () => {
  const valid = {
    v: 1,
    appId: '1234567890123456789',
    mode: 'privacy',
    saltPeriod: 'month',
    salts: [{ period: '2026-11', salt: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8' }],
    serverTime: '2026-11-13T16:42:01.234Z',
  };

  it('accepts current and previous salts and defaults sampling', () => {
    const parsed = ConfigResponse.parse(valid);
    expect(parsed.sampling).toEqual({});
  });

  it('rejects malformed salts, more than two salts and out-of-range sample rates', () => {
    expect(ConfigResponse.safeParse({ ...valid, salts: [{ period: '2026-11', salt: 'short' }] }).success).toBe(false);
    expect(
      ConfigResponse.safeParse({ ...valid, salts: [valid.salts[0], valid.salts[0], valid.salts[0]] }).success,
    ).toBe(false);
    expect(ConfigResponse.safeParse({ ...valid, sampling: { gauge_window: 0 } }).success).toBe(false);
    expect(ConfigResponse.safeParse({ ...valid, sampling: { gauge_window: 1.5 } }).success).toBe(false);
  });
});

describe('IngestAccepted', () => {
  it('defaults rejected to an empty list', () => {
    expect(IngestAccepted.parse({ accepted: 3, duplicates: 1 }).rejected).toEqual([]);
  });
});

describe('interaction_error', () => {
  it('validates as a v1 event', () => {
    const event = {
      id: '0193f2b4-7c1a-7d4e-9a51-3c2f1e0b9a80',
      ts: 1763052121000,
      type: 'interaction_error',
      interaction: '0193f2b4-7c1a-7d4e-9a51-3c2f1e0b9a77',
      command: 'ticket',
      errorClass: 'TypeError',
      handlerMs: 4200,
    };
    expect(Batch.safeParse(batch([event])).success).toBe(true);
    expect(Batch.safeParse(batch([{ ...event, errorClass: undefined }])).success).toBe(false);
  });
});
