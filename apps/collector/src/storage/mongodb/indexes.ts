import { ensureIndexes, LAYOUT_VERSION } from './collections.js';
import type { Mongo } from './connect.js';

const MARKER = 'index_layout';

/**
 * Creates the indexes unless the database already has them for this layout ({@link LAYOUT_VERSION}): one read when
 * nothing changed, where every process of a sharded bot starts at once against a database with an operations limit.
 */
export async function prepareIndexes({ db, c }: Mongo): Promise<void> {
  const made = await c.counters.findOne({ _id: MARKER });
  if (made && made.n >= LAYOUT_VERSION) return;
  await ensureIndexes(db);
  await c.counters.updateOne({ _id: MARKER }, { $max: { n: LAYOUT_VERSION } }, { upsert: true });
}
