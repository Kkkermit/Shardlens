import type pg from 'pg';
import type { Db } from '../../db.js';
import type { LiveChannel, LiveShare, LiveStorage } from '../store.js';

const CHANNEL = 'shardlens_live';
/** Seconds per notification: PostgreSQL refuses a `NOTIFY` payload of 8,000 bytes or more. */
const SECONDS_PER_NOTIFY = 100;

const RETRY_FIRST_MS = 1_000;
const RETRY_MAX_MS = 30_000;

/** Live counts over `LISTEN`/`NOTIFY`, so every collector instance on one database shows the same tiles. */
class PostgresLiveChannel implements LiveChannel {
  readonly #db: Db;
  #listener: pg.PoolClient | undefined;
  #retry: ReturnType<typeof setTimeout> | undefined;
  #retryMs = RETRY_FIRST_MS;
  #stopped = false;
  #warned = false;
  #receive: (share: LiveShare) => void = () => undefined;
  #warn: (message: string) => void = () => undefined;

  constructor(db: Db) {
    this.#db = db;
  }

  subscribe(receive: (share: LiveShare) => void, warn: (message: string) => void): Promise<boolean> {
    this.#receive = receive;
    this.#warn = warn;
    return this.#subscribe();
  }

  async publish(share: LiveShare): Promise<void> {
    for (let i = 0; i < share.counts.length; i += SECONDS_PER_NOTIFY) {
      const payload = JSON.stringify({
        i: share.instance,
        a: share.appId,
        c: share.counts.slice(i, i + SECONDS_PER_NOTIFY),
      });
      await this.#db.query('SELECT pg_notify($1, $2)', [CHANNEL, payload]).catch(() => undefined);
    }
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#retry) clearTimeout(this.#retry);
    const listener = this.#listener;
    if (listener) {
      await listener.query(`UNLISTEN ${CHANNEL}`).catch(() => undefined);
      this.#release(listener, false);
    }
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

  #onNotify(payload: string | undefined): void {
    if (!payload) return;
    try {
      const msg = JSON.parse(payload) as { i?: unknown; a?: unknown; c?: [number, number, number][] };
      if (typeof msg.a !== 'string' || !Array.isArray(msg.c)) return;
      this.#receive({ instance: typeof msg.i === 'string' ? msg.i : '', appId: msg.a, counts: msg.c });
    } catch {
      // A malformed notification is not from a collector.
    }
  }
}

export function postgresLive(db: Db): LiveStorage {
  return {
    channel: () => new PostgresLiveChannel(db),

    async recent(appId) {
      const [p95, shards, servers] = await Promise.all([
        db.query<{ p95: number | null }>(
          `SELECT shardlens_hist_quantile(shardlens_hist_sum(shardlens_hist_one(ack_ms, weight)), 0.95)::float8 AS p95
             FROM interactions WHERE app_id = $1 AND ts > now() - interval '5 minutes'`,
          [appId],
        ),
        db.query<{ shard: number; ping: number; fresh: boolean }>(
          `SELECT DISTINCT ON (shard) shard, value::float8 AS ping, ts > now() - interval '2 minutes' AS fresh
             FROM gauges WHERE app_id = $1 AND name = 'shard.ping_ms' AND ts > now() - interval '1 hour'
            ORDER BY shard, ts DESC`,
          [appId],
        ),
        db.query<{ n: number }>('SELECT count(*)::int AS n FROM guilds WHERE app_id = $1 AND left_at IS NULL', [appId]),
      ]);
      return { p95Ms5m: p95.rows[0]?.p95 ?? null, shards: shards.rows, servers: servers.rows[0]?.n ?? 0 };
    },
  };
}
