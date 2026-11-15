import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import type { Db } from './db.js';

const CHANNEL = 'shardlens_live';
const WINDOW_S = 15 * 60;
/** Seconds per notification: PostgreSQL refuses a `NOTIFY` payload of 8,000 bytes or more. */
const SECONDS_PER_NOTIFY = 100;

const slot = (second: number) => ((second % WINDOW_S) + WINDOW_S) % WINDOW_S;

interface Ring {
  interactions: Float64Array;
  errors: Float64Array;
  /** Epoch seconds, which pass the Int32 range in 2038. */
  second: Float64Array;
}

/**
 * Live counters for the dashboard tiles. Ingest bumps per-second counters in memory and, once a second, publishes the
 * increments with Postgres `NOTIFY`, so every collector instance behind a load balancer shows the same numbers.
 */
export class LiveHub {
  readonly #db: Db;
  readonly #instance = randomBytes(6).toString('hex');
  readonly #rings = new Map<string, Ring>();
  #pending = new Map<string, { s: number; n: number; e: number }[]>();
  #listener: pg.PoolClient | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(db: Db) {
    this.#db = db;
  }

  /** Resolves `false` when this instance could not subscribe: its tiles then only count its own traffic. */
  async start(): Promise<boolean> {
    try {
      const client = await this.#db.connect();
      this.#listener = client;
      client.on('notification', (msg) => this.#onNotify(msg.payload));
      client.on('error', () => this.#release(client, true));
      await client.query(`LISTEN ${CHANNEL}`);
    } catch {
      if (this.#listener) this.#release(this.#listener, true);
    }
    this.#timer = setInterval(() => void this.#publish(), 1_000);
    this.#timer.unref();
    return this.#listener !== undefined;
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    const listener = this.#listener;
    if (listener) {
      await listener.query(`UNLISTEN ${CHANNEL}`).catch(() => undefined);
      this.#release(listener, false);
    }
  }

  bump(appId: string, atMs: number, interactions: number, errors: number): void {
    if (interactions <= 0 && errors <= 0) return;
    const s = Math.floor(atMs / 1000);
    this.#add(appId, s, interactions, errors);
    const list = this.#pending.get(appId) ?? [];
    list.push({ s, n: interactions, e: errors });
    this.#pending.set(appId, list);
  }

  /** Interactions in the last 60 seconds and failures in the last 15 minutes. */
  tiles(appId: string, nowMs = Date.now()): { perMinute: number; errors15m: number; perSecond: number[] } {
    const ring = this.#rings.get(appId);
    const now = Math.floor(nowMs / 1000);
    let perMinute = 0;
    let errors15m = 0;
    const perSecond: number[] = [];
    if (ring) {
      for (let back = 0; back < WINDOW_S; back++) {
        const s = now - back;
        const i = slot(s);
        if (ring.second[i] !== s) continue;
        if (back < 60) perMinute += ring.interactions[i]!;
        errors15m += ring.errors[i]!;
      }
      for (let back = 59; back >= 0; back--) {
        const s = now - back;
        const i = slot(s);
        perSecond.push(ring.second[i] === s ? ring.interactions[i]! : 0);
      }
    }
    return { perMinute: Math.round(perMinute), errors15m: Math.round(errors15m), perSecond };
  }

  /** Returns the listening connection to the pool once. A broken one is destroyed: until then it holds a pool slot. */
  #release(client: pg.PoolClient, broken: boolean): void {
    if (this.#listener !== client) return;
    this.#listener = undefined;
    client.release(broken);
  }

  #add(appId: string, s: number, n: number, e: number): void {
    let ring = this.#rings.get(appId);
    if (!ring) {
      ring = {
        interactions: new Float64Array(WINDOW_S),
        errors: new Float64Array(WINDOW_S),
        second: new Float64Array(WINDOW_S).fill(-1),
      };
      this.#rings.set(appId, ring);
    }
    const i = slot(s);
    if (ring.second[i] !== s) {
      ring.second[i] = s;
      ring.interactions[i] = 0;
      ring.errors[i] = 0;
    }
    ring.interactions[i]! += n;
    ring.errors[i]! += e;
  }

  async #publish(): Promise<void> {
    if (this.#pending.size === 0) return;
    const pending = this.#pending;
    this.#pending = new Map();
    for (const [appId, list] of pending) {
      const bySecond = new Map<number, { n: number; e: number }>();
      for (const { s, n, e } of list) {
        const t = bySecond.get(s) ?? { n: 0, e: 0 };
        t.n += n;
        t.e += e;
        bySecond.set(s, t);
      }
      const counts = [...bySecond].map(([s, t]) => [s, t.n, t.e]);
      for (let i = 0; i < counts.length; i += SECONDS_PER_NOTIFY) {
        const payload = JSON.stringify({ i: this.#instance, a: appId, c: counts.slice(i, i + SECONDS_PER_NOTIFY) });
        await this.#db.query('SELECT pg_notify($1, $2)', [CHANNEL, payload]).catch(() => undefined);
      }
    }
  }

  #onNotify(payload: string | undefined): void {
    if (!payload) return;
    try {
      const msg = JSON.parse(payload) as { i?: string; a?: string; c?: [number, number, number][] };
      if (msg.i === this.#instance || typeof msg.a !== 'string' || !Array.isArray(msg.c)) return;
      for (const [s, n, e] of msg.c) {
        if (Number.isInteger(s) && Number.isFinite(n) && Number.isFinite(e)) this.#add(msg.a, s, n, e);
      }
    } catch {
      // A malformed notification is not from a collector.
    }
  }
}
