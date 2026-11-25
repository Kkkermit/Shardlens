import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Mongo } from '../src/storage/mongodb/connect.js';
import { nextId } from '../src/storage/mongodb/ids.js';
import type { MongoStore } from '../src/storage/mongodb/store.js';
import { mongoStore } from './harness.js';

/** MongoDB's own tests: what the shared suites can't see from the HTTP API. */
describe('MongoStore', () => {
  let backing: Awaited<ReturnType<typeof mongoStore>>;
  let m: Mongo;

  beforeAll(async () => {
    backing = await mongoStore();
    m = (backing.store as MongoStore).mongo;
    await backing.store.prepare();
  });
  afterAll(() => backing?.close());

  it('is ready on a standalone server, and prepares twice without complaint', async () => {
    await backing.store.ready();
    await backing.store.prepare();
    const names = (await m.db.listCollections().toArray()).map((c) => c.name);
    expect(names.every((n) => n.startsWith('shardlens_'))).toBe(true);
    expect(names).toContain('shardlens_interactions');
  });

  it('numbers IDs from 1 per sequence, without repeats under concurrency', async () => {
    expect(await nextId(m.c, 'test_a')).toBe('1');
    const ids = await Promise.all(Array.from({ length: 50 }, () => nextId(m.c, 'test_a')));
    expect(new Set(ids).size).toBe(50);
    expect(Math.max(...ids.map(Number))).toBe(51);
    expect(await nextId(m.c, 'test_b')).toBe('1');
  });
});
