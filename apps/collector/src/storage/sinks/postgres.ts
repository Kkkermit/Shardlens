import pg from 'pg';
import { insertRows } from '../../db.js';
import type { EventSink, StoredEvent } from '../sink.js';

const COLUMNS = ['id', 'ts', 'app_id', 'env', 'bot_release', 'type', 'guild_id', 'user_hash', 'salt_period', 'data'];

/**
 * A PostgreSQL database of your own (Supabase, Neon, RDS or the same server under another name), separate from the
 * collector's. One row per event; the event itself is in the `data` jsonb column.
 */
export class PostgresSink implements EventSink {
  readonly name = 'postgres';
  readonly #pool: pg.Pool;
  readonly #table: string;

  constructor(url: string, table: string) {
    this.#pool = new pg.Pool({ connectionString: url, max: 4, application_name: 'shardlens-sink' });
    this.#pool.on('error', () => undefined);
    this.#table = table;
  }

  async init(): Promise<void> {
    const t = this.#table;
    await this.#pool.query(
      `CREATE TABLE IF NOT EXISTS "${t}" (
         id uuid PRIMARY KEY,
         ts timestamptz NOT NULL,
         app_id text NOT NULL,
         env text NOT NULL,
         bot_release text,
         type text NOT NULL,
         guild_id text,
         user_hash text,
         salt_period text,
         data jsonb NOT NULL
       )`,
    );
    await this.#pool.query(`CREATE INDEX IF NOT EXISTS "${t}_app_ts" ON "${t}" (app_id, ts)`);
    await this.#pool.query(`CREATE INDEX IF NOT EXISTS "${t}_type_ts" ON "${t}" (type, ts)`);
    await this.#pool.query(`CREATE INDEX IF NOT EXISTS "${t}_user" ON "${t}" (user_hash) WHERE user_hash IS NOT NULL`);
  }

  async write(events: readonly StoredEvent[]): Promise<void> {
    const rows = events.map((e) => [
      e.id,
      e.ts,
      e.appId,
      e.env,
      e.release,
      e.type,
      e.guildId,
      e.userHash,
      e.saltPeriod,
      JSON.stringify(e.data),
    ]);
    await insertRows(this.#pool, `"${this.#table}"`, COLUMNS, rows, 'ON CONFLICT (id) DO NOTHING');
  }

  async erase(appId: string, userHashes: readonly string[]): Promise<number> {
    const res = await this.#pool.query(
      `DELETE FROM "${this.#table}" WHERE app_id = $1 AND user_hash = ANY($2::text[])`,
      [appId, [...userHashes]],
    );
    return res.rowCount ?? 0;
  }

  async expire(before: Date): Promise<number> {
    const res = await this.#pool.query(`DELETE FROM "${this.#table}" WHERE ts < $1`, [before]);
    return res.rowCount ?? 0;
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}
