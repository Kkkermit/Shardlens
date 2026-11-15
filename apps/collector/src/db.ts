import pg from 'pg';
import { applyMigrations } from './migrate.js';

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function createPool(databaseUrl: string, max = 10): Db {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max,
    application_name: 'shardlens-collector',
    // Rollup buckets and day boundaries are UTC, whatever time zone the server runs in (`date_trunc` and `to_char`
    // follow the session's). The pool waits for this before handing the connection out.
    onConnect: (client) => client.query("SET TIME ZONE 'UTC'"),
  });
  // Errors on idle clients must not crash the collector; the next query reconnects.
  pool.on('error', () => undefined);
  return pool;
}

/** Applies pending migrations on a connection of their own and returns their names. */
export async function migrate(databaseUrl: string): Promise<string[]> {
  const client = new pg.Client({ connectionString: databaseUrl, application_name: 'shardlens-migrate' });
  await client.connect();
  try {
    return await applyMigrations({
      exec: (sql) => client.query(sql),
      query: (sql, params) => client.query(sql, params),
    });
  } finally {
    await client.end();
  }
}

/**
 * PostgreSQL refused the data itself: a value out of range or text it can't store (class 22), a CHECK it fails, or one
 * statement touching a row twice. Retrying the same input can't help.
 */
export function isRefusedInput(error: unknown): error is { code: string } {
  const e = error as { code?: unknown; severity?: unknown } | null;
  if (typeof e?.code !== 'string' || typeof e.severity !== 'string') return false;
  return /^22[0-9A-Z]{3}$/.test(e.code) || e.code === '23514' || e.code === '21000';
}

export async function transaction<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Multi-row `INSERT … VALUES` with bound parameters. `table`, `columns` and `suffix` come from code, never from input.
 * Returns the number of rows actually inserted (conflicts excluded).
 */
export async function insertRows(
  tx: Tx | Db,
  table: string,
  columns: readonly string[],
  rows: readonly (readonly unknown[])[],
  suffix = 'ON CONFLICT DO NOTHING',
  onInserted?: (firstColumn: string[]) => void,
): Promise<number> {
  if (rows.length === 0) return 0;
  let inserted = 0;
  // Postgres allows 65,535 parameters per statement.
  const perStatement = Math.max(1, Math.floor(60_000 / columns.length));
  for (let start = 0; start < rows.length; start += perStatement) {
    const chunk = rows.slice(start, start + perStatement);
    const params: unknown[] = [];
    const values = chunk.map((row) => {
      const placeholders = row.map((value) => {
        params.push(value);
        return `$${params.length}`;
      });
      return `(${placeholders.join(', ')})`;
    });
    // With `onInserted`, the first column of each inserted row (the event ID) is returned, so callers can tell new
    // rows from retries.
    const returning = onInserted ? ` RETURNING ${columns[0]}::text AS first` : '';
    const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${values.join(', ')} ${suffix}${returning}`;
    const result = await tx.query<{ first: string }>(sql, params);
    inserted += result.rowCount ?? 0;
    if (onInserted) onInserted(result.rows.map((r) => r.first));
  }
  return inserted;
}
