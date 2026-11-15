import { describe, expect, it } from 'vitest';
import { CUSTOM_EVENT_NAME, MAX_CUSTOM_PROPS_BYTES, sanitiseCustomProps } from '../src/index.js';

describe('sanitiseCustomProps', () => {
  it('copies strings, finite numbers, booleans and null', () => {
    expect(sanitiseCustomProps({ plan: 'pro', seats: 3, trial: false, coupon: null })).toEqual({
      plan: 'pro',
      seats: 3,
      trial: false,
      coupon: null,
    });
    expect(sanitiseCustomProps(undefined)).toEqual({});
  });

  it('refuses anything outside the limits rather than sending part of it', () => {
    expect(sanitiseCustomProps(null)).toBeUndefined();
    expect(sanitiseCustomProps(['a'])).toBeUndefined();
    expect(sanitiseCustomProps({ n: Number.NaN })).toBeUndefined();
    expect(sanitiseCustomProps({ n: 1n })).toBeUndefined();
    expect(sanitiseCustomProps({ nested: {} })).toBeUndefined();
    expect(sanitiseCustomProps({ ['k'.repeat(65)]: 1 })).toBeUndefined();
    expect(sanitiseCustomProps({ s: 'x'.repeat(257) })).toBeUndefined();
    const big = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, 'x'.repeat(200)]));
    expect(JSON.stringify(big).length).toBeGreaterThan(MAX_CUSTOM_PROPS_BYTES);
    expect(sanitiseCustomProps(big)).toBeUndefined();
  });

  it('redacts secrets, and replaces NUL in keys and values, which the collector refuses', () => {
    const out = sanitiseCustomProps({ 'a\0b': 'x\0y', note: 'key slk_ingest_abcdefghijklmnopqrstuvwxyz0123' });
    expect(out).toEqual({ 'a�b': 'x�y', note: 'key slk_ingest_[key]' });
    expect(JSON.stringify(out)).not.toContain('\\u0000');
  });
});

describe('CUSTOM_EVENT_NAME', () => {
  it('takes lower snake case starting with a letter, up to 64 characters', () => {
    expect(CUSTOM_EVENT_NAME.test('ticket_opened')).toBe(true);
    expect(CUSTOM_EVENT_NAME.test(`a${'b'.repeat(63)}`)).toBe(true);
    expect(CUSTOM_EVENT_NAME.test(`a${'b'.repeat(64)}`)).toBe(false);
    expect(CUSTOM_EVENT_NAME.test('Ticket')).toBe(false);
    expect(CUSTOM_EVENT_NAME.test('1st')).toBe(false);
  });
});
