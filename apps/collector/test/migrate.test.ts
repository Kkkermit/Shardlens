import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from '../src/migrate.js';

let pg: PGlite;

beforeAll(async () => {
  pg = await PGlite.create();
});

afterAll(async () => {
  await pg.close();
});

describe('migrations', () => {
  it('applies every migration once, in order, and records it', { timeout: 60_000 }, async () => {
    const applied = await applyMigrations(pg);
    expect(applied.length).toBeGreaterThanOrEqual(3);
    expect(applied).toEqual([...applied].sort());
    const recorded = await pg.query<{ name: string }>('SELECT name FROM pgmigrations ORDER BY id');
    expect(recorded.rows.map((row) => row.name)).toEqual(applied);

    expect(await applyMigrations(pg)).toEqual([]);
  });

  it('keeps no column for a server owner', async () => {
    const columns = await pg.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'guilds'",
    );
    const names = columns.rows.map((column) => column.column_name);
    expect(names).toContain('member_count');
    expect(names.filter((name) => name.includes('owner'))).toEqual([]);
  });

  it('refuses a database it does not recognise, and leaves no lock behind', async () => {
    await pg.query("INSERT INTO pgmigrations (name, run_on) VALUES ('999_from_a_newer_collector', now())");
    await expect(applyMigrations(pg)).rejects.toThrow(/older than the database/);

    const held = await pg.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'");
    expect(held.rows[0]?.n).toBe(0);
  });
});
