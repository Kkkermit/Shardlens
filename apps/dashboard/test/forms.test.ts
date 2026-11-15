import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, errorText, onUnauthorized, request } from '../src/api';
import { decimal, firstCharacters, initials, ms, num, pct, quoted } from '../src/format';
import { activityFilterError, changedFields, isSnowflake, permissionBitsError } from '../src/forms';
import { loginError } from '../src/routes/shell';
import { pageCount, parseServerListSearch, searchText } from '../src/server-list';

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
    expect(failed).toMatchObject({ status: 500, code: 'internal', requestId: 'req-7' });
    expect(errorText(failed)).toBe('The collector ran into an error.');

    vi.stubGlobal('fetch', answer(400, { error: 'invalid_request', issues: [{ path: ['webhookUrl'] }] }));
    const invalid = await api('/v1/alerts', { body: {} }).catch((e: unknown) => e);
    expect(errorText(invalid)).toBe('Please check the webhook URL and try again.');
    expect(errorText(new ApiError(400, 'invalid_request'))).toBe('Please check the values and try again.');
    expect(errorText(new ApiError(429, 'rate_limited'))).toBe('Too many attempts. Wait a minute and try again.');
    expect(errorText(new ApiError(400, 'invalid_request', { fields: ['constructor'] }))).toBe(
      'Please check constructor and try again.',
    );
  });

  it('says what went wrong in words, never as a bare code', async () => {
    // The collector's own explanation wins (a webhook Discord refused).
    vi.stubGlobal('fetch', answer(502, { error: 'webhook_failed', message: 'Discord answered 404 (Unknown Webhook)' }));
    expect(errorText(await api('/v1/alerts/1/test', { body: {} }).catch((e: unknown) => e))).toBe(
      'Discord answered 404 (Unknown Webhook)',
    );
    // A proxy's error page has no code.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>Bad gateway</html>', { status: 502 })),
    );
    const proxied = await api('/v1/query', { body: {} }).catch((e: unknown) => e);
    expect(proxied).toMatchObject({ status: 502, code: 'http_502' });
    expect(errorText(proxied)).toBe('The collector ran into an error.');
    // No answer at all: fetch rejects with a TypeError.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))),
    );
    expect(errorText(await api('/v1/query', { body: {} }).catch((e: unknown) => e))).toBe(
      "Couldn't reach the collector. Check your connection and try again.",
    );
    expect(errorText(new ApiError(404, 'not_found'))).toBe(
      'It no longer exists. Reload the page to see what is there now.',
    );
    expect(errorText(new ApiError(403, 'not_a_team_member'))).toBe(
      'Only the app owner and its team members can do this.',
    );
    expect(errorText(new ApiError(400, 'nothing_to_erase'))).toBe('The request failed (nothing_to_erase).');
    expect(errorText(new ApiError(400, 'invalid_request', { fields: ['guild'] }))).toBe(
      'Please check the server ID and try again.',
    );
  });

  it('sends the confirmation headers an export needs and hands back the file', async () => {
    const fetch = vi.fn(async () => new Response('time,user_id\n', { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const res = await request('/v1/audit/export.csv', { headers: { 'x-shardlens-confirm': 'export-audit-log' } });
    expect(await res.text()).toBe('time,user_id\n');
    expect(fetch).toHaveBeenCalledWith(
      '/v1/audit/export.csv',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ 'x-shardlens-confirm': 'export-audit-log' }),
      }),
    );
  });
});

describe('names inside plain-text messages', () => {
  it('are quoted and isolated, so a right-to-left override cannot reorder the sentence', () => {
    expect(quoted('Missed deadlines')).toBe('“\u2068Missed deadlines\u2069”');
    expect(`${quoted('\u202Eevil')} deleted.`.indexOf('\u2069')).toBeLessThan(
      `${quoted('\u202Eevil')} deleted.`.indexOf('deleted'),
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

  it('checks activity filters and permission bits before the collector would refuse them', () => {
    expect(activityFilterError({ command: 'ticket', guild: '', user: ' 80351110224678912 ' })).toBe('');
    expect(activityFilterError({ command: '', guild: 'abc', user: '' })).toBe('A server ID is 17 to 19 digits.');
    expect(activityFilterError({ command: '', guild: '', user: '12' })).toBe('A user ID is 17 to 19 digits.');
    expect(activityFilterError({ command: 'x'.repeat(33), guild: '', user: '' })).toMatch(/32 characters/);
    expect(permissionBitsError('')).toBe('');
    expect(permissionBitsError('277025770560')).toBe('');
    expect(permissionBitsError('9223372036854775807')).toBe('');
    expect(permissionBitsError('9223372036854775808')).not.toBe('');
    expect(permissionBitsError('99999999999999999999')).not.toBe('');
    expect(permissionBitsError('12a')).not.toBe('');
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

describe('server list search box', () => {
  it('keeps what was typed and puts only a real search in the address', () => {
    expect(searchText(' ')).toBeUndefined();
    expect(searchText(' pix')).toBe(' pix');
    expect(searchText('a'.repeat(120))).toHaveLength(100);
    expect(pageCount(0, 50)).toBe(1);
    expect(pageCount(50, 50)).toBe(1);
    expect(pageCount(53, 50)).toBe(2);
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
