import type { Db } from 'mongodb';

/** How long a measured offset is used before it is measured again. */
const REMEASURE_MS = 10 * 60_000;

/**
 * MongoDB's clock, read from this process. In the bot every process runs a collector, each on its own host's clock,
 * and one of them runs the rollups: ingest's "late" and the leader's rollup windows must follow one clock, or a host a
 * few minutes behind the leader writes events that no run rolls up. The offset comes from the `localTime` in `hello`,
 * taken halfway through the round trip, and is measured again in the background every 10 minutes.
 */
export class ServerClock {
  readonly #db: Db;
  #offset = 0;
  #checkedAt = Number.NEGATIVE_INFINITY;
  #measuring: Promise<void> | undefined;

  constructor(db: Db) {
    this.#db = db;
  }

  /** Epoch milliseconds by MongoDB's clock: this host's, until a measurement succeeds. */
  now(): number {
    const local = Date.now();
    if (local - this.#checkedAt > REMEASURE_MS) this.measure().catch(() => undefined);
    return local + this.#offset;
  }

  /** One measurement at a time; a failed one keeps the last offset and is tried again in 10 minutes. */
  measure(): Promise<void> {
    this.#measuring ??= this.#measure().finally(() => {
      this.#measuring = undefined;
    });
    return this.#measuring;
  }

  async #measure(): Promise<void> {
    const sent = Date.now();
    this.#checkedAt = sent;
    const reply = await this.#db.command({ hello: 1 });
    const received = Date.now();
    if (reply.localTime instanceof Date) this.#offset = reply.localTime.getTime() - (sent + received) / 2;
  }
}
