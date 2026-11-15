import { describe, expect, it } from 'vitest';
import { avatarHash, compact, errorClass, errorCode } from '../src/index.js';

describe('errorClass', () => {
  it('names the class of an error and never includes its message', () => {
    class TicketError extends Error {}
    expect(errorClass(new TicketError('user 123 said something private'))).toBe('TicketError');
    expect(errorClass(new RangeError('x'))).toBe('RangeError');
  });

  it('describes thrown values that are not errors by their type', () => {
    expect(errorClass('boom')).toBe('string');
    expect(errorClass({ reason: 'x' })).toBe('Object');
    expect(errorClass(null)).toBe('object');
    expect(errorClass(undefined)).toBe('undefined');
  });

  it('never throws for an error whose class name was overwritten', () => {
    const odd = new Error('x');
    Object.defineProperty(odd, 'constructor', { value: { name: 42 } });
    expect(errorClass(odd)).toBe('Error');
    const hostile = new TypeError('x');
    Object.defineProperty(hostile, 'constructor', {
      get() {
        throw new Error('getter');
      },
    });
    expect(errorClass(hostile)).toBe('Error');
  });

  it('caps very long class names', () => {
    const Long = { [`E${'x'.repeat(200)}`]: class extends Error {} };
    expect(errorClass(new (Object.values(Long)[0] as ErrorConstructor)())).toHaveLength(64);
  });
});

describe('errorCode', () => {
  it('returns integer codes only', () => {
    expect(errorCode({ code: 50013 })).toBe(50013);
    expect(errorCode({ code: 'ECONNRESET' })).toBeUndefined();
    expect(errorCode({ code: 1.5 })).toBeUndefined();
    expect(errorCode(null)).toBeUndefined();
    expect(errorCode('x')).toBeUndefined();
  });
});

describe('compact', () => {
  it('drops undefined values and keeps every other falsy value', () => {
    expect(compact({ a: 1, b: undefined, c: null, d: 0, e: '', f: false })).toEqual({
      a: 1,
      c: null,
      d: 0,
      e: '',
      f: false,
    });
    expect(Object.keys(compact({ a: undefined }))).toEqual([]);
  });
});

describe('avatarHash', () => {
  it('passes Discord avatar hashes through and nothing else', () => {
    expect(avatarHash('0123456789abcdef0123456789abcdef')).toBe('0123456789abcdef0123456789abcdef');
    expect(avatarHash('a_0123456789abcdef0123456789abcdef')).toBe('a_0123456789abcdef0123456789abcdef');
    expect(avatarHash(null)).toBeUndefined();
    expect(avatarHash('https://example.com/me.png')).toBeUndefined();
    expect(avatarHash('../../etc/passwd')).toBeUndefined();
  });
});
