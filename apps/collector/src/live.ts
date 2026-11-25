import { randomBytes } from 'node:crypto';
import type { LiveChannel, LiveShare } from './storage/store.js';

const WINDOW_S = 15 * 60;

const slot = (second: number) => ((second % WINDOW_S) + WINDOW_S) % WINDOW_S;

interface Ring {
  interactions: Float64Array;
  errors: Float64Array;
  /** Epoch seconds, which pass the Int32 range in 2038. */
  second: Float64Array;
}

/**
 * Live counters for the dashboard tiles. Ingest bumps per-second counters in memory and, once a second, publishes the
 * increments on the store's live channel, so every collector instance behind a load balancer shows the same numbers.
 */
export class LiveHub {
  readonly #channel: LiveChannel;
  readonly #instance = randomBytes(6).toString('hex');
  readonly #rings = new Map<string, Ring>();
  #pending = new Map<string, { s: number; n: number; e: number }[]>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #watchers = 0;
  #warn: (message: string) => void = () => undefined;

  constructor(channel: LiveChannel) {
    this.#channel = channel;
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
    const subscribed = await this.#channel.subscribe(
      (share) => this.#receive(share),
      (message) => this.#warn(message),
    );
    this.#timer = setInterval(() => void this.#publish(), 1_000);
    this.#timer.unref();
    return subscribed;
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    await this.#channel.stop();
  }

  /**
   * Counts a live stream as open until the returned function is called, so the channel knows whether this instance
   * shows tiles to anyone (`LiveChannel.listen`).
   */
  watch(): () => void {
    if (this.#watchers++ === 0) this.#channel.listen?.(true);
    let open = true;
    return () => {
      if (!open) return;
      open = false;
      if (--this.#watchers === 0) this.#channel.listen?.(false);
    };
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
      const counts: LiveShare['counts'] = [...bySecond].map(([s, t]) => [s, t.n, t.e]);
      // Runs on a timer: a failure here must not become an unhandled rejection.
      await this.#channel.publish({ instance: this.#instance, appId, counts }).catch(() => undefined);
    }
  }

  /** Another instance's counts. Shares come from outside this process, so each count is checked. */
  #receive(share: LiveShare): void {
    if (share.instance === this.#instance) return;
    for (const [s, n, e] of share.counts) {
      if (Number.isInteger(s) && Number.isFinite(n) && Number.isFinite(e)) this.#add(share.appId, s, n, e);
    }
  }
}
