import { createPool, type Pool } from 'mysql2/promise';
import type { EventSink, StoredEvent } from '../sink.js';

const COLUMNS = 'id, ts, app_id, env, bot_release, type, guild_id, user_hash, salt_period, data';

/**
 * MySQL 8 and MariaDB 10.5+. One row per event; the event itself is in the `data` JSON column. Times are stored in UTC.
 * The table name is a checked identifier from the operator's settings; every value is a bound parameter.
 */
export class MysqlSink implements EventSink {
  readonly name = 'mysql';
  readonly #pool: Pool;
  readonly #table: string;

  constructor(url: string, table: string) {
    this.#pool = createPool({ uri: url, timezone: 'Z', connectionLimit: 4, connectTimeout: 10_000 });
    this.#table = table;
  }

  async init(): Promise<void> {
    const t = this.#table;
    await this.#pool.query(
      `CREATE TABLE IF NOT EXISTS \`${t}\` (
         id CHAR(36) NOT NULL PRIMARY KEY,
         ts DATETIME(3) NOT NULL,
         app_id VARCHAR(20) NOT NULL,
         env VARCHAR(32) NOT NULL,
         bot_release VARCHAR(64) NULL,
         type VARCHAR(32) NOT NULL,
         guild_id VARCHAR(20) NULL,
         user_hash CHAR(32) NULL,
         salt_period VARCHAR(10) NULL,
         data JSON NOT NULL,
         KEY \`${t}_ts\` (ts),
         KEY \`${t}_app_ts\` (app_id, ts),
         KEY \`${t}_type_ts\` (type, ts),
         KEY \`${t}_user\` (user_hash)
       )`,
    );
  }

  async write(events: readonly StoredEvent[]): Promise<void> {
    if (events.length === 0) return;
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
    // `id = id` turns a duplicate into a no-op without hiding other errors, as `INSERT IGNORE` would.
    await this.#pool.query(`INSERT INTO \`${this.#table}\` (${COLUMNS}) VALUES ? ON DUPLICATE KEY UPDATE id = id`, [
      rows,
    ]);
  }

  async erase(appId: string, userHashes: readonly string[]): Promise<number> {
    if (userHashes.length === 0) return 0;
    const [res] = await this.#pool.query(`DELETE FROM \`${this.#table}\` WHERE app_id = ? AND user_hash IN (?)`, [
      appId,
      [...userHashes],
    ]);
    return (res as { affectedRows?: number }).affectedRows ?? 0;
  }

  async expire(before: Date): Promise<number> {
    const [res] = await this.#pool.query(`DELETE FROM \`${this.#table}\` WHERE ts < ?`, [before]);
    return (res as { affectedRows?: number }).affectedRows ?? 0;
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}
