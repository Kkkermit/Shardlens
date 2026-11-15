import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import type { Db } from './db.js';

const CHANNEL = 'shardlens_live';
const WINDOW_S = 15 * 60;
/** Seconds per notification: PostgreSQL refuses a `NOTIFY` payload of 8,000 bytes or more. */
const SECONDS_PER_NOTIFY = 100;

const RETRY_FIRST_MS = 1_000;
const RETRY_MAX_MS = 30_000;

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
  #retry: ReturnType<typeof setTimeout> | undefined;
  #retryMs = RETRY_FIRST_MS;
  #stopped = false;
  #warned = false;
  #warn: (message: string) => void = () => undefined;

  constructor(db: Db) {
    this.#db = db;
  }

  /** Where to report a lost subscription (once per outage). */
  onWarning(warn: (message: string) => void): void {
    this.#warn = warn;
  }

  /**
   * Resolves `false` when this instance could not subscribe: its tiles then only count its own traffic until a retry
   * in the background succeeds.
   */
  async start(): Promise<boolean> {
    const subscribed = await this.#subscribe();
    this.#timer = setInterval(() => void this.#publish(), 1_000);
    this.#timer.unref();
    return subscribed;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    if (this.#retry) clearTimeout(this.#retry);
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

  async #subscribe(): Promise<boolean> {
    let client: pg.PoolClient | undefined;
    try {
      client = await this.#db.connect();
      if (this.#stopped) {
        client.release();
        return false;
      }
      const subscribed = client;
      this.#listener = subscribed;
      subscribed.on('notification', (msg) => this.#onNotify(msg.payload));
      subscribed.on('error', () => this.#lost(subscribed));
      await subscribed.query(`LISTEN ${CHANNEL}`);
      this.#retryMs = RETRY_FIRST_MS;
      this.#warned = false;
      return true;
    } catch {
      if (client) this.#lost(client);
      else this.#retryLater();
      return false;
    }
  }

  /** The listening connection broke (the database restarted, say): subscribe again, backing off up to 30 seconds. */
  #lost(client: pg.PoolClient): void {
    if (this.#listener !== client) return;
    this.#release(client, true);
    if (!this.#warned) {
      this.#warned = true;
      this.#warn('Live tiles lost their LISTEN connection to PostgreSQL; subscribing again.');
    }
    this.#retryLater();
  }

  #retryLater(): void {
    if (this.#stopped || this.#retry) return;
    this.#retry = setTimeout(() => {
      this.#retry = undefined;
      void this.#subscribe();
    }, this.#retryMs);
    this.#retry.unref();
    this.#retryMs = Math.min(RETRY_MAX_MS, this.#retryMs * 2);
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
