import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import type { EventSink, StoredEvent } from '../sink.js';

/** Rows deleted per statement, so a large expiry never holds the event loop (the bot's, in embedded mode) for long. */
const DELETE_CHUNK = 2_000;

/**
 * A SQLite file, through Node's built-in `node:sqlite` (no extra dependency). Times are ISO 8601 text in UTC, so they
 * sort and compare as text; the event itself is JSON text in `data`, readable with SQLite's JSON functions.
 *
 * `node:sqlite` is synchronous. Writes come in batches of at most 500 rows, and expiry deletes in small chunks with a
 * pause between them, so the event loop is never held for long.
 */
export class SqliteSink implements EventSink {
  readonly name = 'sqlite';
  readonly #path: string;
  readonly #table: string;
  #db: DatabaseSync | undefined;
  #insert: StatementSync | undefined;

  constructor(path: string, table: string) {
    if (path.trim() === '') throw new Error('sqlite sink needs a file path, for example sqlite:./shardlens-events.db');
    this.#path = resolve(path);
    this.#table = table;
  }

  async init(): Promise<void> {
    if (this.#db) return;
    const { DatabaseSync } = await import('node:sqlite');
    mkdirSync(dirname(this.#path), { recursive: true });
    const db = new DatabaseSync(this.#path);
    const t = this.#table;
    db.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS "${t}" (
        id TEXT PRIMARY KEY,
        ts TEXT NOT NULL,
        app_id TEXT NOT NULL,
        env TEXT NOT NULL,
        bot_release TEXT,
        type TEXT NOT NULL,
        guild_id TEXT,
        user_hash TEXT,
        salt_period TEXT,
        data TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS "${t}_ts" ON "${t}" (ts);
      CREATE INDEX IF NOT EXISTS "${t}_app_ts" ON "${t}" (app_id, ts);
      CREATE INDEX IF NOT EXISTS "${t}_type_ts" ON "${t}" (type, ts);
      CREATE INDEX IF NOT EXISTS "${t}_user" ON "${t}" (user_hash);`);
    this.#insert = db.prepare(
      `INSERT OR IGNORE INTO "${t}" (id, ts, app_id, env, bot_release, type, guild_id, user_hash, salt_period, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.#db = db;
  }

  async write(events: readonly StoredEvent[]): Promise<void> {
    const db = this.#ready();
    const insert = this.#insert as StatementSync;
    db.exec('BEGIN');
    try {
      for (const e of events) {
        insert.run(
          e.id,
          e.ts.toISOString(),
          e.appId,
          e.env,
          e.release,
          e.type,
          e.guildId,
          e.userHash,
          e.saltPeriod,
          JSON.stringify(e.data),
        );
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  async erase(appId: string, userHashes: readonly string[]): Promise<number> {
    if (userHashes.length === 0) return 0;
    const placeholders = userHashes.map(() => '?').join(', ');
    const res = this.#ready()
      .prepare(`DELETE FROM "${this.#table}" WHERE app_id = ? AND user_hash IN (${placeholders})`)
      .run(appId, ...userHashes);
    return Number(res.changes);
  }

  async expire(before: Date): Promise<number> {
    const t = this.#table;
    const chunk = this.#ready().prepare(
      `DELETE FROM "${t}" WHERE id IN (SELECT id FROM "${t}" WHERE ts < ? ORDER BY ts LIMIT ${DELETE_CHUNK})`,
    );
    let deleted = 0;
    for (;;) {
      const n = Number(chunk.run(before.toISOString()).changes);
      deleted += n;
      if (n < DELETE_CHUNK || !this.#db) return deleted;
      await yieldToEventLoop();
    }
  }

  async close(): Promise<void> {
    this.#db?.close();
    this.#db = undefined;
  }

  #ready(): DatabaseSync {
    if (!this.#db) throw new Error('SQLite sink used before init()');
    return this.#db;
  }
}
