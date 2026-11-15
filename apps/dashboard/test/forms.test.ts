import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, errorText, onUnauthorized } from '../src/api';
import { decimal, firstCharacters, initials, ms, num, pct } from '../src/format';
import { changedFields, isSnowflake } from '../src/forms';
import { loginError } from '../src/routes/shell';
import { parseServerListSearch } from '../src/server-list';

afterEach(() => {
  vi.unstubAllGlobals();
  onUnauthorized(() => undefined);
});

const answer = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

describe('failed requests', () => {
  it('goes back to sign-in when a session is refused, but not for a wrong read key', async () => {
    const signedOut = vi.fn();
    onUnauthorized(signedOut);
    vi.stubGlobal('fetch', answer(401, { error: 'unauthorized' }));
    await expect(api('/v1/query', { body: {} })).rejects.toBeInstanceOf(ApiError);
    expect(signedOut).toHaveBeenCalledTimes(1);
    await expect(api('/auth/read-key', { body: { key: 'x' } })).rejects.toBeInstanceOf(ApiError);
    expect(signedOut).toHaveBeenCalledTimes(1);
  });

  it('keeps the request ID and names the fields that were refused', async () => {
    vi.stubGlobal('fetch', answer(500, { error: 'internal', requestId: 'req-7' }));
    const failed = await api('/v1/query', { body: {} }).catch((e: unknown) => e);
    expect(failed).toMatchObject({ status: 500, message: 'internal', requestId: 'req-7' });

    vi.stubGlobal('fetch', answer(400, { error: 'invalid_request', issues: [{ path: ['webhookUrl'] }] }));
    const invalid = await api('/v1/alerts', { body: {} }).catch((e: unknown) => e);
    expect(errorText(invalid)).toBe('Please check the webhook URL and try again.');
    expect(errorText(new ApiError(400, 'invalid_request'))).toBe('Please check the values and try again.');
    expect(errorText(new ApiError(429, 'rate_limited'))).toBe('Too many attempts. Wait a minute and try again.');
    expect(errorText(new ApiError(400, 'invalid_request', { fields: ['constructor'] }))).toBe(
      'Please check constructor and try again.',
    );
  });
});

describe('sign-in errors from the address', () => {
  it('shows known messages only, whatever the URL says', () => {
    expect(loginError(null)).toBe('');
    expect(loginError('invalid_state')).toBe('The sign-in link expired. Please try again.');
    expect(loginError('__proto__')).toBe('Sign-in failed.');
    expect(loginError('constructor')).toBe('Sign-in failed.');
  });
});

describe('form input', () => {
  it('accepts the Discord IDs the collector accepts', () => {
    expect(isSnowflake('80351110224678912')).toBe(true);
    expect(isSnowflake('9199999999999999999')).toBe(true);
    expect(isSnowflake('9223372036854775808')).toBe(false);
    expect(isSnowflake('18446744073709551615')).toBe(false);
    expect(isSnowflake(' 80351110224678912')).toBe(false);
    expect(isSnowflake('1234')).toBe(false);
  });

  it('sends only the settings that changed', () => {
    const current = { timezone: 'Asia/Calcutta', rawRetentionDays: 35, badges: ['servers'] };
    expect(changedFields(current, { timezone: 'Asia/Calcutta', rawRetentionDays: 14 })).toEqual({
      rawRetentionDays: 14,
    });
    expect(changedFields(current, { badges: ['servers'] })).toEqual({});
    expect(changedFields(current, { badges: [] })).toEqual({ badges: [] });
  });
});

describe('numbers in one locale', () => {
  it('uses the same separators for counts, shares and durations', () => {
    expect(num(13_750, 'de-DE')).toBe('13.750');
    expect(pct(0.059, 1, 'de-DE')).toMatch(/^5,9\s%$/u);
    expect(ms(3_600, 'de-DE')).toBe('3,6 s');
    expect(decimal(2.5, 2, 'de-DE')).toBe('2,50');
    expect(pct(0.059)).toBe('5.9%');
    expect(ms(12_400)).toBe('12 s');
  });
});

describe('initials', () => {
  it('never splits an emoji', () => {
    expect(initials('🎮 Pixel Party', 3)).toBe('🎮PP');
    expect(initials('  ', 3)).toBe('');
    expect(firstCharacters('🇬🇧abc', 2)).toBe('🇬🇧a');
    expect(initials('ünïcode server', 3)).toBe('ÜS');
  });
});

describe('server list address', () => {
  it('keeps known filters and drops anything else', () => {
    expect(parseServerListSearch({ q: 'gaming', status: 'all', page: 3, inactive: true, dir: 'asc' })).toEqual({
      q: 'gaming',
      status: 'all',
      page: 3,
      inactive: true,
      dir: 'asc',
    });
    expect(
      parseServerListSearch({ status: 'active', sort: 'members', page: 1, size: '1-9', missing: 'no', evil: '<x>' }),
    ).toEqual({});
    expect(parseServerListSearch({ page: -2, sort: 'joined', missing: 'true' })).toEqual({
      sort: 'joined',
      missing: true,
    });
  });
});
