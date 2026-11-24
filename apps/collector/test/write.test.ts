import { uuidv7 } from '@shardlens/core';
import { parseBatch } from '@shardlens/schema';
import { describe, expect, it } from 'vitest';
import type { Tx } from '../src/db.js';
import { writeEvents } from '../src/storage/postgres/ingest/write.js';
import type { IngestItem } from '../src/storage/store.js';

// Concurrent batches share unique-user rows and late minutes, and an insert waits for whichever batch inserted the
// same row first. Two batches taking those rows in different orders deadlocked under load, so every batch must take
// them in one order, whatever order its events came in.

const APP_ID = '1234567890123456789';
const PERIOD = '2026-11';
const NOW = Date.UTC(2026, 10, 23, 12, 0);
const USERS = Array.from({ length: 6 }, (_, i) => `h1:${PERIOD}:${String(i).repeat(32)}`);

function batch(): IngestItem[] {
  const events = USERS.flatMap((user, i) =>
    ['ticket', 'help'].map((command, j) => ({
      id: uuidv7(),
      // Some on the day before, some minutes late: several days and several late minutes in one batch.
      ts: NOW - (i % 2) * 86_400_000 - (i + j) * 60_000,
      type: 'interaction',
      kind: 'chat_input',
      command,
      options: [],
      context: 0,
      install: 'guild',
      guild: `11223344556677889${i % 3}`,
      locale: i % 2 ? 'de' : 'en-GB',
      user,
      premium: false,
      outcome: 'ok',
      deferred: false,
    })),
  );
  const parsed = parseBatch({
    v: 1,
    mode: 'privacy',
    sdk: { name: '@shardlens/discordjs', version: '1.0.0' },
    app: { id: APP_ID, env: 'production' },
    source: { shards: [0], instance: 'test:1' },
    sentAt: new Date(NOW).toISOString(),
    events,
  });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  expect(parsed.errors).toEqual([]);
  return parsed.events.map((event, index) => ({ index, event }));
}

/** The parameters of each insert into `table`, as the writer sent them. */
async function inserted(items: IngestItem[], table: string): Promise<unknown[]> {
  const params: unknown[] = [];
  const tx = {
    query: async (sql: string, values?: unknown[]) => {
      if (sql.startsWith(`INSERT INTO ${table} `)) params.push(...(values ?? []));
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Tx;
  await writeEvents(
    tx,
    {
      appId: APP_ID,
      env: 'production',
      release: undefined,
      instance: 'test:1',
      shards: [0],
      sdkVersion: '@shardlens/discordjs@1.0.0',
      livePeriods: new Set([PERIOD]),
      now: new Date(NOW),
    },
    items,
  );
  return params;
}

const rowsOf = (params: unknown[], width: number) =>
  Array.from({ length: params.length / width }, (_, i) =>
    params.slice(i * width, (i + 1) * width).map((v) => (Buffer.isBuffer(v) ? v.toString('hex') : String(v))),
  );

describe('rows that concurrent batches share', () => {
  it('are inserted in one order whatever order the batch is in', async () => {
    const items = batch();
    const shuffled = [...items].reverse();
    shuffled.push(shuffled.splice(3, 1)[0]!);

    const uniques = await inserted(items, 'uniques');
    expect(await inserted(shuffled, 'uniques')).toEqual(uniques);
    const late = await inserted(items, 'dirty_buckets');
    expect(late.length).toBeGreaterThan(1);
    expect(await inserted(shuffled, 'dirty_buckets')).toEqual(late);
  });

  it('inserts each unique-user row once', async () => {
    const rows = rowsOf(await inserted(batch(), 'uniques'), 6);
    expect(new Set(rows.map((row) => row.join('|'))).size).toBe(rows.length);
    // Everyone ran two commands on one day: one row each for the whole bot.
    expect(rows.filter((row) => row[3] === 'global')).toHaveLength(USERS.length);
  });
});
