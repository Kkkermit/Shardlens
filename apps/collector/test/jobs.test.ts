import { EventEmitter } from 'node:events';
import { uuidv7 } from '@shardlens/core';
import type { Event } from '@shardlens/schema';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db.js';
import { startJobs } from '../src/jobs/scheduler.js';
import { LiveHub } from '../src/live.js';
import { type EventSink, SinkMirror, type StoredEvent } from '../src/storage/sink.js';

const APP = '1234567890123456789';
const HEX = '9f3c1a0b6e2d4f7a8c5b1e3d2a4f6c8e';
const silent = { info: () => undefined, error: () => undefined };

afterEach(() => {
  vi.useRealTimers();
});

describe('job scheduler', () => {
  it('skips a tick while the same job is still running, instead of queueing it again', async () => {
    vi.useFakeTimers();
    let claims = 0;
    let release: () => void = () => undefined;
    const stuck = new Promise<void>((resolve) => {
      release = resolve;
    });
    const query = async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ ok: true }] };
      if (sql.includes('DELETE FROM dirty_buckets')) {
        // The first rollup run takes minutes; later ones are quick.
        if (++claims === 1) await stuck;
      }
      return { rows: [], rowCount: 0 };
    };
    const client = Object.assign(new EventEmitter(), { query, release: () => undefined });
    const db = { query, connect: async () => client } as unknown as Db;
    const jobs = startJobs(db, silent);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(claims).toBe(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    // Five ticks passed while it ran; none of them left a run waiting behind it.
    expect(claims).toBe(1);
    await jobs.stop();
  });
});

describe('live tiles subscription', () => {
  it('subscribes again after the database drops the listening connection', async () => {
    vi.useFakeTimers();
    const clients: EventEmitter[] = [];
    const listens: number[] = [];
    const db = {
      connect: async () => {
        const client = Object.assign(new EventEmitter(), {
          query: async (sql: string) => {
            if (sql.startsWith('LISTEN')) listens.push(clients.length);
            return { rows: [] };
          },
          release: () => undefined,
        });
        clients.push(client);
        return client;
      },
      query: async () => ({ rows: [] }),
    } as unknown as Db;
    const warnings: string[] = [];
    const hub = new LiveHub(db);
    hub.onWarning((message) => warnings.push(message));
    expect(await hub.start()).toBe(true);
    clients[0]?.emit('error', new Error('terminating connection due to administrator command'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(listens).toEqual([1, 2]);
    expect(warnings).toHaveLength(1);
    await hub.stop();
  });
});

describe('event sink erasure', () => {
  it('waits for the batch being written, not for a buffer that never empties under load', async () => {
    const writes: StoredEvent[][] = [];
    const sink: EventSink = {
      name: 'slow',
      write: async (events) => {
        writes.push([...events]);
        await new Promise((resolve) => setTimeout(resolve, 100));
      },
      erase: async () => 0,
      expire: async () => 0,
      close: async () => undefined,
    };
    const mirror = new SinkMirror(sink);
    const event = (user?: string): Event =>
      ({
        id: uuidv7(),
        ts: Date.now(),
        type: 'custom',
        name: 'load',
        props: {},
        ...(user ? { user: `h1:2026-11:${user}` } : {}),
      }) as Event;
    const ctx = { appId: APP, env: 'production', release: undefined };
    mirror.push(ctx, [event(HEX), ...Array.from({ length: 600 }, () => event())]);
    // Steady traffic: the buffer always holds more than one batch.
    const load = setInterval(
      () =>
        mirror.push(
          ctx,
          Array.from({ length: 600 }, () => event()),
        ),
      50,
    );
    try {
      void mirror.flush();
      const started = Date.now();
      await mirror.erase(APP, [Buffer.from(HEX, 'hex')]);
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      clearInterval(load);
    }
  });
});
