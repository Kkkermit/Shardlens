import type { Db } from 'mongodb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerClock } from '../src/storage/mongodb/clock.js';

const MINUTE = 60_000;

/** A database whose `hello` answers with what `reply` gives, counting the calls. */
function server(reply: () => Promise<object>) {
  const calls = { count: 0 };
  const db = {
    command: () => {
      calls.count++;
      return reply();
    },
  } as unknown as Db;
  return { db, calls };
}

describe('ServerClock', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads the time by MongoDB's clock once measured", async () => {
    const { db } = server(async () => ({ localTime: new Date(Date.now() + 4 * MINUTE) }));
    const clock = new ServerClock(db);
    await clock.measure();
    expect(clock.now() - Date.now()).toBeGreaterThan(4 * MINUTE - 1_000);
    expect(clock.now() - Date.now()).toBeLessThan(4 * MINUTE + 1_000);
  });

  it("keeps the host's time when the server doesn't say its own, or can't be reached", async () => {
    for (const reply of [async () => ({ ok: 1 }), () => Promise.reject(new Error('unreachable'))]) {
      const clock = new ServerClock(server(reply).db);
      await clock.measure().catch(() => undefined);
      expect(Math.abs(clock.now() - Date.now())).toBeLessThan(1_000);
    }
  });

  it('measures again in the background every 10 minutes, and not before, even after a failure', async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 0, 1) });
    let offset = MINUTE;
    let fail = false;
    const { db, calls } = server(async () => {
      if (fail) throw new Error('unreachable');
      return { localTime: new Date(Date.now() + offset) };
    });
    const clock = new ServerClock(db);
    await clock.measure();
    offset = 2 * MINUTE;
    fail = true;
    vi.advanceTimersByTime(10 * MINUTE + 1);
    expect(clock.now() - Date.now()).toBe(MINUTE);
    await vi.waitFor(() => expect(calls.count).toBe(2));
    clock.now();
    vi.advanceTimersByTime(9 * MINUTE);
    clock.now();
    expect(calls.count).toBe(2);

    fail = false;
    vi.advanceTimersByTime(MINUTE + 1);
    clock.now();
    await vi.waitFor(() => expect(clock.now() - Date.now()).toBe(2 * MINUTE));
    expect(calls.count).toBe(3);
  });
});
