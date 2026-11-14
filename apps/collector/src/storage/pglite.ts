import type { PGlite } from '@electric-sql/pglite';
import type { Db } from '../db.js';

/**
 * Adapts PGlite (in-process PostgreSQL, ADR 0012) to the part of the `pg` Pool API the collector uses: `query`,
 * `connect`/`release` for transactions, a LISTEN client and `end`. PGlite has one connection, so statements are
 * serialised and a transaction holds the connection until it commits or rolls back.
 */

type QueryResult = { rows: Record<string, unknown>[]; rowCount: number };

/** pg returns int8 and numeric as strings and bytea as Buffer; match it so the collector code behaves the same. */
export const PG_COMPATIBLE_PARSERS = {
  20: (value: string) => value, // int8 (and int8[] elements)
  1700: (value: string) => value, // numeric
  17: (value: string) => Buffer.from(value.startsWith('\\x') ? value.slice(2) : value, 'hex'), // bytea
};

class Mutex {
  #tail: Promise<void> = Promise.resolve();
  lock(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.#tail;
    this.#tail = previous.then(() => next);
    return previous.then(() => release);
  }
}

const TX_START = /^\s*(BEGIN|START TRANSACTION)\b/i;
const TX_END = /^\s*(COMMIT|ROLLBACK|END)\b/i;

function toResult(result: { rows: unknown[]; affectedRows?: number }): QueryResult {
  return { rows: result.rows as Record<string, unknown>[], rowCount: result.affectedRows ?? result.rows.length };
}

async function run(pg: PGlite, text: string, params?: readonly unknown[]): Promise<QueryResult> {
  if (params && params.length > 0) return toResult(await pg.query(text, [...params]));
  // Without parameters `pg` allows several statements (simple protocol); PGlite's exec does the same.
  const results = await pg.exec(text);
  const last = results.at(-1);
  return last ? toResult(last) : { rows: [], rowCount: 0 };
}

type NotificationListener = (msg: { channel: string; payload: string }) => void;

class PgliteClient {
  readonly #pg: PGlite;
  readonly #mutex: Mutex;
  #release: (() => void) | undefined;
  readonly #listeners = new Set<NotificationListener>();
  readonly #unlisten = new Map<string, () => Promise<void>>();

  constructor(pg: PGlite, mutex: Mutex) {
    this.#pg = pg;
    this.#mutex = mutex;
  }

  async query(text: string, params?: readonly unknown[]): Promise<QueryResult> {
    const listen = /^\s*(UN)?LISTEN\s+([a-z_][a-z0-9_]*)\s*$/i.exec(text);
    if (listen) {
      const channel = listen[2] as string;
      if (listen[1]) {
        await this.#unlisten.get(channel)?.();
        this.#unlisten.delete(channel);
      } else if (!this.#unlisten.has(channel)) {
        const off = await this.#pg.listen(channel, (payload) => {
          for (const l of this.#listeners) l({ channel, payload });
        });
        this.#unlisten.set(channel, off);
      }
      return { rows: [], rowCount: 0 };
    }
    if (this.#release) {
      // Inside our transaction: we already hold the connection.
      try {
        return await run(this.#pg, text, params);
      } finally {
        if (TX_END.test(text)) this.#endTransaction();
      }
    }
    if (TX_START.test(text)) {
      this.#release = await this.#mutex.lock();
      try {
        return await run(this.#pg, text, params);
      } catch (error) {
        this.#endTransaction();
        throw error;
      }
    }
    const release = await this.#mutex.lock();
    try {
      return await run(this.#pg, text, params);
    } finally {
      release();
    }
  }

  on(event: string, listener: (...args: never[]) => void): this {
    if (event === 'notification') this.#listeners.add(listener as unknown as NotificationListener);
    return this;
  }

  release(): void {
    // A client returned mid-transaction (after an error, for example) must not keep the connection locked.
    if (this.#release) {
      void run(this.#pg, 'ROLLBACK').catch(() => undefined);
      this.#endTransaction();
    }
    for (const off of this.#unlisten.values()) void off().catch(() => undefined);
    this.#unlisten.clear();
    this.#listeners.clear();
  }

  #endTransaction(): void {
    const release = this.#release;
    this.#release = undefined;
    release?.();
  }
}

/** A `pg`-Pool-shaped wrapper around one PGlite instance. */
export function pgliteDb(pg: PGlite): Db {
  const mutex = new Mutex();
  const pool = {
    async query(text: string, params?: readonly unknown[]) {
      const release = await mutex.lock();
      try {
        return await run(pg, text, params);
      } finally {
        release();
      }
    },
    async connect() {
      return new PgliteClient(pg, mutex);
    },
    on() {
      return pool;
    },
    async end() {
      await pg.close();
    },
  };
  return pool as unknown as Db;
}
