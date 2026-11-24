import { describe, expect, it } from 'vitest';
import { LruMap } from '../src/util.js';

describe('LruMap', () => {
  it('keeps at most max entries and evicts the least recently set', () => {
    const map = new LruMap<number, number>(32);
    for (let i = 0; i < 1_000; i++) {
      map.set(i, i);
      expect(map.size).toBeLessThanOrEqual(32);
    }
    expect(map.has(999)).toBe(true);
    expect(map.has(0)).toBe(false);

    // Setting a key again makes it the most recent: it outlives keys set after it the first time.
    map.set(990, 990);
    for (let i = 1_000; i < 1_025; i++) map.set(i, i);
    expect(map.has(990)).toBe(true);
    expect(map.has(991)).toBe(false);
  });

  it('evicts a batch at a time rather than one entry per insert', () => {
    // One eviction per insert walks over every slot V8 keeps for deleted entries, so each insert cost time in
    // proportion to `max` once the map was full (half of the SDK's CPU per interaction at its 20,000-entry maps).
    const map = new LruMap<number, number>(32);
    for (let i = 0; i <= 32; i++) map.set(i, i);
    expect(map.size).toBe(31);
    expect([...map.keys()].slice(0, 2)).toEqual([2, 3]);
    map.set(33, 33);
    expect(map.size).toBe(32);
    map.set(34, 34);
    expect(map.size).toBe(31);
  });
});
