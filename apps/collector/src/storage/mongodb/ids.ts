import type { Collections } from './collections.js';

/**
 * The next number of a sequence, as a decimal string: the IDs of keys, alert rules, reports and log rows, which routes
 * take as up to 18 digits (an ObjectId would not do). Starts at 1, like PostgreSQL's identity columns.
 */
export async function nextId(c: Collections, sequence: string): Promise<string> {
  const doc = await c.counters.findOneAndUpdate(
    { _id: sequence },
    { $inc: { n: 1 } },
    { upsert: true, returnDocument: 'after' },
  );
  if (!doc) throw new Error(`MongoStore: sequence ${sequence} returned nothing`);
  return String(doc.n);
}
