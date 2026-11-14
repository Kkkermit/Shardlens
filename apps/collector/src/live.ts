import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import type { Db } from './db.js';

const CHANNEL = 'shardlens_live';
const WINDOW_S = 15 * 60;

interface Ring {
  interactions: Float64Array;
  errors: Float64Array;
  second: Int32Array;
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
      this.#listener = await this.#db.connect();
      this.#listener.on('notification', (msg) => this.#onNotify(msg.payload));
      this.#listener.on('error', () => {
        this.#listener = undefined;
      });
      await this.#listener.query(`LISTEN ${CHANNEL}`);
    } catch {
      this.#listener?.release(true);
      this.#listener = undefined;
    }
    this.#timer = setInterval(() => void this.#publish(), 1_000);
    this.#timer.unref();
    return this.#listener !== undefined;
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    if (this.#listener) {
      await this.#listener.query(`UNLISTEN ${CHANNEL}`).catch(() => undefined);
      this.#listener.release();
      this.#listener = undefined;
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
        const i = ((s % WINDOW_S) + WINDOW_S) % WINDOW_S;
        if (ring.second[i] !== s) continue;
        if (back < 60) perMinute += ring.interactions[i]!;
        errors15m += ring.errors[i]!;
      }
      for (let back = 59; back >= 0; back--) {
        const s = now - back;
        const i = ((s % WINDOW_S) + WINDOW_S) % WINDOW_S;
        perSecond.push(ring.second[i] === s ? ring.interactions[i]! : 0);
      }
    }
    return { perMinute: Math.round(perMinute), errors15m: Math.round(errors15m), perSecond };
  }

  #add(appId: string, s: number, n: number, e: number): void {
    let ring = this.#rings.get(appId);
    if (!ring) {
      ring = {
        interactions: new Float64Array(WINDOW_S),
        errors: new Float64Array(WINDOW_S),
        second: new Int32Array(WINDOW_S).fill(-1),
      };
      this.#rings.set(appId, ring);
    }
    const i = ((s % WINDOW_S) + WINDOW_S) % WINDOW_S;
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
      const payload = JSON.stringify({ i: this.#instance, a: appId, c: [...bySecond].map(([s, t]) => [s, t.n, t.e]) });
      if (payload.length > 7_900) continue;
      await this.#db.query('SELECT pg_notify($1, $2)', [CHANNEL, payload]).catch(() => undefined);
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
      // ignore malformed notifications
    }
  }
}
