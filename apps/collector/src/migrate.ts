import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Works from `src/` in development and from `dist/` in the image and the published package. */
const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
/** Arbitrary constant: every collector takes the same advisory lock, so only one migrates at a time. */
const ADVISORY_LOCK = 7_241_865_325;

/** One dedicated connection. A `pg.Client` (see `migrate` in `db.ts`) and a PGlite instance both fit. */
export interface MigrationConnection {
  /** Runs one or more statements that take no parameters. */
  exec(sql: string): Promise<unknown>;
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/**
 * Applies the pending `migrations/*.sql` files in name order, each in its own transaction, and returns their names.
 * Applied migrations are recorded in `pgmigrations`. Refuses to run when the database is ahead of, or has diverged
 * from, the files on disk, which is what happens when an older collector is started against a newer database.
 */
export async function applyMigrations(conn: MigrationConnection): Promise<string[]> {
  await conn.exec(`SELECT pg_advisory_lock(${ADVISORY_LOCK})`);
  try {
    await conn.exec(
      'CREATE TABLE IF NOT EXISTS pgmigrations (id serial PRIMARY KEY, name varchar(255) NOT NULL, run_on timestamp NOT NULL)',
    );
    const done = (await conn.query('SELECT name FROM pgmigrations ORDER BY id')).rows.map((row) => String(row.name));
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((file) => file.endsWith('.sql'))
      .sort();
    const names = files.map((file) => file.slice(0, -'.sql'.length));
    done.forEach((name, i) => {
      if (names[i] !== name) {
        throw new Error(
          `Database migration "${name}" does not match this collector's migrations. Is this collector older than the database?`,
        );
      }
    });

    const applied: string[] = [];
    for (const [i, name] of names.entries()) {
      if (i < done.length) continue;
      await conn.exec('BEGIN');
      try {
        await conn.exec(readFileSync(join(MIGRATIONS_DIR, files[i] as string), 'utf8'));
        await conn.query('INSERT INTO pgmigrations (name, run_on) VALUES ($1, now())', [name]);
        await conn.exec('COMMIT');
      } catch (error) {
        await conn.exec('ROLLBACK').catch(() => undefined);
        throw new Error(`Migration ${name} failed: ${error instanceof Error ? error.message : String(error)}`, {
          cause: error,
        });
      }
      applied.push(name);
    }
    return applied;
  } finally {
    await conn.exec(`SELECT pg_advisory_unlock(${ADVISORY_LOCK})`).catch(() => undefined);
  }
}
