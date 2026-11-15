import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { BoundedQueue, type Priority } from '../src/index.js';

describe('BoundedQueue', () => {
  it('evicts the lowest priority first when full', () => {
    const q = new BoundedQueue<string>(3);
    q.push('gauge', 0);
    q.push('rest', 1);
    q.push('interaction-1', 3);
    q.push('interaction-2', 3);
    expect(q.size).toBe(3);
    expect(q.dropped).toEqual([1, 0, 0, 0]);
    expect(q.take(10).map((x) => x.item)).toEqual(['interaction-1', 'interaction-2', 'rest']);
  });

  it('refuses a low-priority item when only higher-priority items remain', () => {
    const q = new BoundedQueue<string>(2);
    q.push('a', 3);
    q.push('b', 2);
    q.push('gauge', 0);
    expect(q.size).toBe(2);
    expect(q.dropped).toEqual([1, 0, 0, 0]);
    expect(q.take(10).map((x) => x.item)).toEqual(['a', 'b']);
  });

  it('evicts the oldest item of an equal-priority lane', () => {
    const q = new BoundedQueue<string>(2);
    q.push('old', 3);
    q.push('mid', 3);
    q.push('new', 3);
    expect(q.take(10).map((x) => x.item)).toEqual(['mid', 'new']);
    expect(q.dropped[3]).toBe(1);
  });

  it('takes highest priority first, oldest first within a lane', () => {
    const q = new BoundedQueue<string>(10);
    q.push('g1', 0);
    q.push('i1', 3);
    q.push('c1', 2);
    q.push('i2', 3);
    expect(q.take(3)).toEqual([
      { item: 'i1', priority: 3 },
      { item: 'i2', priority: 3 },
      { item: 'c1', priority: 2 },
    ]);
    expect(q.size).toBe(1);
  });

  it('requeues a failed batch at the front, in order', () => {
    const q = new BoundedQueue<string>(10);
    q.push('i1', 3);
    q.push('i2', 3);
    const batch = q.take(2);
    q.push('i3', 3);
    q.requeue(batch);
    expect(q.take(10).map((x) => x.item)).toEqual(['i1', 'i2', 'i3']);
  });

  it('lets requeued interactions evict gauges that arrived while sending', () => {
    const q = new BoundedQueue<string>(2);
    q.push('i1', 3);
    q.push('i2', 3);
    const batch = q.take(2);
    q.push('g1', 0);
    q.push('g2', 0);
    q.requeue(batch);
    expect(q.take(10).map((x) => x.item)).toEqual(['i1', 'i2']);
    expect(q.dropped).toEqual([2, 0, 0, 0]);
  });

  it('drops requeued items rather than evicting newer items of the same priority', () => {
    const q = new BoundedQueue<string>(1);
    q.push('i1', 3);
    const batch = q.take(1);
    q.push('i2', 3);
    q.requeue(batch);
    expect(q.take(10).map((x) => x.item)).toEqual(['i2']);
    expect(q.dropped[3]).toBe(1);
  });

  it('requeues a batch in one step per lane, not one per item', () => {
    const q = new BoundedQueue<number>(100_000);
    for (let i = 0; i < 99_000; i++) q.push(i, 3);
    const batch = q.take(499);
    // One `unshift` per item moves the whole lane each time, which stalled a very large queue on every retry. Counted
    // rather than timed: a time limit fails on a busy machine.
    const unshift = vi.spyOn(Array.prototype, 'unshift');
    q.requeue(batch);
    const calls = unshift.mock.calls.length;
    unshift.mockRestore();
    expect(calls).toBe(0);
    expect(q.take(2).map((x) => x.item)).toEqual([0, 1]);
    expect(q.size).toBe(98_998);
  });

  it('removes the items a predicate picks, from every lane', () => {
    const q = new BoundedQueue<string>(10);
    q.push('a:1', 3);
    q.push('b:1', 2);
    q.push('a:2', 0);
    expect(q.removeWhere((item) => item.startsWith('a:'))).toBe(2);
    expect(q.size).toBe(1);
    expect(q.take(10).map((x) => x.item)).toEqual(['b:1']);
  });

  it('rejects a non-positive capacity', () => {
    expect(() => new BoundedQueue(0)).toThrow(RangeError);
  });

  it('never exceeds capacity and accounts for every item (property)', () => {
    const op = fc.oneof(
      fc.record({ kind: fc.constant('push' as const), priority: fc.constantFrom<Priority>(0, 1, 2, 3) }),
      fc.record({ kind: fc.constant('take' as const), n: fc.nat({ max: 20 }) }),
      fc.record({ kind: fc.constant('fail' as const), n: fc.nat({ max: 20 }) }),
    );
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 50 }), fc.array(op, { maxLength: 300 }), (capacity, ops) => {
        const q = new BoundedQueue<number>(capacity);
        let pushed = 0;
        let delivered = 0;
        for (const o of ops) {
          if (o.kind === 'push') {
            q.push(pushed++, o.priority);
          } else if (o.kind === 'take') {
            delivered += q.take(o.n).length;
          } else {
            q.requeue(q.take(o.n));
          }
          expect(q.size).toBeLessThanOrEqual(capacity);
          const dropped = q.dropped.reduce((a, b) => a + b, 0);
          expect(q.size + delivered + dropped).toBe(pushed);
        }
      }),
    );
  });
});
