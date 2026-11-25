import { type Filter, ObjectId } from 'mongodb';
import type { LiveChannel, LiveShare, LiveStorage } from '../store.js';
import type { LiveShareDoc } from './collections.js';
import type { Mongo } from './connect.js';
import { ACK_WEIGHTS, ackQuantile } from './histogram.js';

/*
 * Live tiles on MongoDB, which has no push on a standalone server: instances share counts through `shardlens_live` and
 * read them by polling. Every process of a sharded bot may be an instance on one free-tier database, and most of the
 * time nobody watches, so the work follows demand:
 *
 * - An instance polls only while it has a live stream open, and says so in `shardlens_live_listeners`.
 * - An instance with traffic keeps its counts of the last 15 minutes to itself until it sees another instance listening
 *   (it asks every 10 seconds while it holds any), then sends them, and from then on about once a second.
 * - An idle instance with no stream open costs nothing.
 *
 * Writes are stamped with the server's clock (`$$NOW`), so readers, the TTL indexes and the listener check go by one
 * clock whatever the hosts' clocks say.
 */

const SECOND = 1_000;
/** How far back the tiles look (`LiveHub`): older counts are dropped, never handed over. */
const WINDOW_S = 15 * 60;
const POLL_MS = SECOND;
/** Shares are read from this long before the newest one seen: one stamped earlier may become visible later. */
const OVERLAP_MS = 5 * SECOND;
/** Shares read in one poll at most; a full read is followed by another at once. */
const MAX_READ = 2_000;
const LISTENER_BEAT_MS = 20 * SECOND;
/** A listener not renewed for this long has gone. */
const LISTENER_FRESH_MS = 45 * SECOND;
/** How often an instance holding counts asks whether another instance listens. */
const LISTENER_CHECK_MS = 10 * SECOND;
/** A stream that closes and opens again within this time (a page reload) does not stop the polling. */
const LINGER_MS = 30 * SECOND;
const RETRY_FIRST_MS = SECOND;
const RETRY_MAX_MS = 30 * SECOND;

type Timer = ReturnType<typeof setTimeout>;

function later(fn: () => void, ms: number): Timer {
  const t = setTimeout(fn, ms);
  t.unref();
  return t;
}

const nowSecond = () => Math.floor(Date.now() / SECOND);

class MongoLiveChannel implements LiveChannel {
  readonly #m: Mongo;
  /** This channel's document in `shardlens_live_listeners`. */
  readonly #id = new ObjectId().toHexString();
  #receive: (share: LiveShare) => void = () => undefined;
  #warn: (message: string) => void = () => undefined;
  #stopped = false;
  /** Reached the server once: a failure after that is an outage, and warned about. */
  #reached = false;
  #warned = false;
  #retryMs = RETRY_FIRST_MS;
  #retry: Timer | undefined;

  #listening = false;
  #linger: Timer | undefined;
  #poll: Timer | undefined;
  #polling: Promise<void> | undefined;
  #beatAt = -Infinity;
  /** The server time of the newest share read. */
  #newest: number | undefined;
  /** Shares read within the overlap, by ID, so none is handed over twice. */
  readonly #seen = new Map<string, number>();

  /** The instances whose shares this channel sent: their shares are not read back. */
  readonly #own = new Set<string>();
  /** Counts not sent yet, by app and second. */
  readonly #unsent = new Map<string, { instance: string; seconds: Map<number, [number, number]> }>();
  /** Shares formed but not confirmed written, retried with the same ID so a lost reply can't count them twice. */
  readonly #outbox: Pick<LiveShareDoc, '_id' | 'instance' | 'appId' | 'counts'>[] = [];
  #flushing: Promise<void> | undefined;
  #recheck: Timer | undefined;
  #checkedAt = -Infinity;
  #othersListen = false;

  constructor(m: Mongo) {
    this.#m = m;
  }

  async subscribe(receive: (share: LiveShare) => void, warn: (message: string) => void): Promise<boolean> {
    this.#receive = receive;
    this.#warn = warn;
    return this.#connect();
  }

  listen(active: boolean): void {
    if (this.#stopped) return;
    if (active) {
      if (this.#linger) clearTimeout(this.#linger);
      this.#linger = undefined;
      if (this.#listening) return;
      this.#listening = true;
      this.#beatAt = -Infinity;
      this.#schedulePoll(0);
      return;
    }
    if (!this.#listening || this.#linger) return;
    this.#linger = later(() => {
      this.#linger = undefined;
      this.#listening = false;
      if (this.#poll) clearTimeout(this.#poll);
      this.#poll = undefined;
      void this.#m.c.liveListeners.deleteOne({ _id: this.#id }).catch(() => undefined);
    }, LINGER_MS);
  }

  async publish(share: LiveShare): Promise<void> {
    if (this.#stopped) return;
    this.#own.add(share.instance);
    const oldest = nowSecond() - WINDOW_S;
    let pending = this.#unsent.get(share.appId);
    for (const [s, n, e] of share.counts) {
      if ((n === 0 && e === 0) || s < oldest) continue;
      pending ??= { instance: share.instance, seconds: new Map() };
      const t = pending.seconds.get(s) ?? [0, 0];
      pending.seconds.set(s, [t[0] + n, t[1] + e]);
    }
    if (!pending || pending.seconds.size === 0) return;
    this.#unsent.set(share.appId, pending);
    await this.#flush();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    for (const t of [this.#retry, this.#linger, this.#poll, this.#recheck]) if (t) clearTimeout(t);
    await Promise.allSettled([this.#polling, this.#flushing]);
    if (this.#listening) await this.#m.c.liveListeners.deleteOne({ _id: this.#id }).catch(() => undefined);
  }

  async #connect(): Promise<boolean> {
    try {
      await this.#m.db.command({ ping: 1 });
      this.#reached = true;
      this.#recovered();
      return true;
    } catch {
      if (!this.#stopped && !this.#retry) {
        this.#retry = later(() => {
          this.#retry = undefined;
          void this.#connect();
        }, this.#retryMs);
        this.#retryMs = Math.min(RETRY_MAX_MS, this.#retryMs * 2);
      }
      return false;
    }
  }

  #recovered(): void {
    this.#retryMs = RETRY_FIRST_MS;
    this.#warned = false;
  }

  /** Lost the server while polling: try again, backing off up to 30 seconds, and warn once per outage. */
  #lost(): number {
    if (this.#reached && !this.#warned) {
      this.#warned = true;
      this.#warn('Live tiles lost their connection to MongoDB; polling again.');
    }
    const wait = this.#retryMs;
    this.#retryMs = Math.min(RETRY_MAX_MS, this.#retryMs * 2);
    return wait;
  }

  #schedulePoll(ms: number): void {
    if (this.#stopped || !this.#listening) return;
    if (this.#poll) clearTimeout(this.#poll);
    this.#poll = later(() => {
      this.#poll = undefined;
      this.#polling = this.#read().finally(() => {
        this.#polling = undefined;
      });
    }, ms);
  }

  async #read(): Promise<void> {
    const { c } = this.#m;
    let next = POLL_MS;
    try {
      if (this.#listening && performance.now() - this.#beatAt >= LISTENER_BEAT_MS) {
        await c.liveListeners.updateOne({ _id: this.#id }, [{ $set: { at: '$$NOW' } }], { upsert: true });
        this.#beatAt = performance.now();
      }
      // The first read since start-up takes what the tiles show: the last 15 minutes, by the server's clock.
      const filter: Filter<LiveShareDoc> =
        this.#newest === undefined
          ? { $expr: { $gte: ['$at', { $subtract: ['$$NOW', WINDOW_S * SECOND] }] } }
          : { at: { $gte: new Date(this.#newest - OVERLAP_MS) } };
      if (this.#own.size > 0) filter.instance = { $nin: [...this.#own] };
      const shares = await c.liveShares.find(filter).sort({ at: 1 }).limit(MAX_READ).toArray();
      this.#reached = true;
      this.#recovered();
      for (const share of shares) this.#deliver(share);
      if (this.#newest !== undefined) {
        for (const [id, at] of this.#seen) if (at < this.#newest - 2 * OVERLAP_MS) this.#seen.delete(id);
      }
      if (shares.length === MAX_READ) next = 0;
    } catch {
      next = this.#lost();
    }
    this.#schedulePoll(next);
  }

  #deliver(doc: LiveShareDoc): void {
    if (this.#seen.has(doc._id)) return;
    const at = doc.at instanceof Date ? doc.at.getTime() : Number.NaN;
    if (Number.isNaN(at)) return;
    this.#seen.set(doc._id, at);
    if (this.#newest === undefined || at > this.#newest) this.#newest = at;
    if (typeof doc.appId !== 'string' || !Array.isArray(doc.counts)) return;
    // A count older than the tiles' window would land in the slot of a second they still show.
    const oldest = nowSecond() - WINDOW_S;
    const counts = doc.counts.filter((c) => Array.isArray(c) && c.length === 3 && c[0] >= oldest);
    if (counts.length === 0) return;
    try {
      this.#receive({ instance: typeof doc.instance === 'string' ? doc.instance : '', appId: doc.appId, counts });
    } catch {
      // A malformed share is not from a collector.
    }
  }

  /**
   * Sends what is held, once another instance listens. One flush at a time. `recheck` asks whether anyone listens
   * even if it was asked less than {@link LISTENER_CHECK_MS} ago: the recheck timer can fire a moment before that by
   * `performance.now()`, and the cached "nobody" would hold the counts back for another round.
   */
  #flush(recheck = false): Promise<void> {
    this.#flushing ??= this.#send(recheck).finally(() => {
      this.#flushing = undefined;
      this.#keepChecking();
    });
    return this.#flushing;
  }

  async #send(recheck: boolean): Promise<void> {
    for (let first = true; ; first = false) {
      if (this.#stopped || !(await this.#anotherListens(recheck && first))) return;
      for (const [appId, { instance, seconds }] of this.#unsent) {
        const counts: LiveShareDoc['counts'] = [...seconds].map(([s, [n, e]]) => [s, n, e]);
        this.#outbox.push({ _id: new ObjectId().toHexString(), instance, appId, counts });
      }
      this.#unsent.clear();
      if (this.#outbox.length === 0) return;
      while (this.#outbox.length > 0) {
        const share = this.#outbox[0]!;
        await this.#m.c.liveShares.updateOne(
          { _id: share._id },
          [
            {
              $set: {
                instance: { $literal: share.instance },
                appId: { $literal: share.appId },
                counts: { $literal: share.counts },
                // A retry keeps the time of a write whose reply was lost: stamped again, the share would be read
                // again by an instance that has forgotten its ID by then.
                at: { $ifNull: ['$at', '$$NOW'] },
              },
            },
          ],
          { upsert: true },
        );
        this.#outbox.shift();
      }
    }
  }

  async #anotherListens(fresh: boolean): Promise<boolean> {
    if (!fresh && performance.now() - this.#checkedAt < LISTENER_CHECK_MS) return this.#othersListen;
    const listener = await this.#m.c.liveListeners.findOne(
      { _id: { $ne: this.#id }, $expr: { $gt: ['$at', { $subtract: ['$$NOW', LISTENER_FRESH_MS] }] } },
      { projection: { _id: 1 } },
    );
    this.#othersListen = listener !== null;
    this.#checkedAt = performance.now();
    return this.#othersListen;
  }

  /** While counts are held back, asks again now and then, so they reach a stream that opens after the traffic. */
  #keepChecking(): void {
    if (this.#stopped || this.#recheck) return;
    const oldest = nowSecond() - WINDOW_S;
    for (const [appId, { seconds }] of this.#unsent) {
      for (const s of seconds.keys()) if (s < oldest) seconds.delete(s);
      if (seconds.size === 0) this.#unsent.delete(appId);
    }
    for (const share of this.#outbox) share.counts = share.counts.filter(([s]) => s >= oldest);
    while (this.#outbox[0]?.counts.length === 0) this.#outbox.shift();
    if (this.#unsent.size === 0 && this.#outbox.length === 0) return;
    this.#recheck = later(() => {
      this.#recheck = undefined;
      void this.#flush(true).catch(() => undefined);
    }, LISTENER_CHECK_MS);
  }
}

export function mongoLive(m: Mongo): LiveStorage {
  const { c } = m;
  return {
    channel: () => new MongoLiveChannel(m),

    async recent(appId) {
      const now = Date.now();
      const [ack, shards, servers] = await Promise.all([
        c.interactions
          .aggregate<{ _id: number; w: number }>([
            { $match: { appId, ts: { $gt: new Date(now - 5 * 60 * SECOND) } } },
            ...ACK_WEIGHTS,
          ])
          .toArray(),
        c.gauges
          .aggregate<{ _id: number; ping: number; ts: Date }>([
            {
              $match: {
                '_id.appId': appId,
                '_id.name': 'shard.ping_ms',
                '_id.ts': { $gt: new Date(now - 3_600 * SECOND) },
              },
            },
            {
              $group: {
                _id: '$_id.shard',
                latest: { $top: { sortBy: { '_id.ts': -1 }, output: ['$value', '$_id.ts'] } },
              },
            },
            { $project: { ping: { $arrayElemAt: ['$latest', 0] }, ts: { $arrayElemAt: ['$latest', 1] } } },
            { $sort: { _id: 1 } },
          ])
          .toArray(),
        c.guilds.countDocuments({ '_id.appId': appId, leftAt: { $exists: false } }),
      ]);
      return {
        p95Ms5m: ackQuantile(ack, 0.95),
        shards: shards.map((s) => ({ shard: s._id, ping: s.ping, fresh: s.ts.getTime() > now - 2 * 60 * SECOND })),
        servers,
      };
    },
  };
}
