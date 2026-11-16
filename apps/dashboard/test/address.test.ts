import { describe, expect, it } from 'vitest';
import { parseActivitySearch } from '../src/activity-search';
import { parseSearch, stringifySearch } from '../src/address';
import { parseServerListSearch } from '../src/server-list';

describe('search parameters', () => {
  it('keeps a Discord ID from a hand-written link digit for digit', () => {
    // Read as JSON, this ID becomes the number 123456789012345680: another server.
    const raw = parseSearch('?guild=123456789012345678&outcome=failed');
    expect(raw).toEqual({ guild: '123456789012345678', outcome: 'failed' });
    expect(parseActivitySearch(raw)).toEqual({ guild: '123456789012345678', outcome: 'failed' });
  });

  it('writes values as they are, and reads them back the same', () => {
    const search = { guild: '123456789012345678', command: 'ban', outcome: 'failed' };
    expect(stringifySearch(search)).toBe('?guild=123456789012345678&command=ban&outcome=failed');
    expect(parseSearch(stringifySearch(search))).toEqual(search);
    expect(stringifySearch({})).toBe('');
    expect(stringifySearch({ q: undefined, page: 2, inactive: true })).toBe('?page=2&inactive=true');
    for (const q of [' Night', '123', 'true', '"quoted"', '"', 'a&b=c', '50% off']) {
      expect(parseSearch(stringifySearch({ q })), q).toEqual({ q });
    }
  });

  it('still opens links written when values were JSON', () => {
    expect(parseSearch('?q=%22123%22&page=2&inactive=true')).toEqual({ q: '123', page: '2', inactive: 'true' });
    expect(parseServerListSearch(parseSearch('?q=%22123%22&page=2&inactive=true'))).toEqual({
      q: '123',
      page: 2,
      inactive: true,
    });
  });
});

describe('activity log address', () => {
  it('keeps the filters the collector accepts and drops the rest', () => {
    expect(parseActivitySearch({ command: ' ticket ', guild: '80351110224678912', outcome: 'timeout' })).toEqual({
      command: 'ticket',
      guild: '80351110224678912',
      outcome: 'timeout',
    });
    expect(
      parseActivitySearch({ command: 'x'.repeat(33), guild: 'abc', outcome: 'broken', evil: '<x>', page: '4' }),
    ).toEqual({});
    expect(parseActivitySearch({ command: '', guild: '', outcome: '' })).toEqual({});
  });

  it('never takes a user ID from the address', () => {
    expect(parseActivitySearch({ user: '80351110224678912', outcome: 'failed' })).toEqual({ outcome: 'failed' });
  });
});
