import {
  BSON,
  type Collection,
  type Document,
  MongoBulkWriteError,
  MongoServerError,
  type OptionalUnlessRequiredId,
} from 'mongodb';
import { isDuplicateKey } from './duplicate-key.js';

/** MongoDB's code for a time zone its own time zone database does not know (Node's may). */
export const UNKNOWN_TIME_ZONE = 40485;

/**
 * Server codes for input MongoDB refuses whatever the retry: a document over 16 MB, written whole or grown by an
 * update, and a time zone it doesn't know (PostgreSQL's 22023 for the same query).
 */
const REFUSED = new Set([10334, 17419, UNKNOWN_TIME_ZONE]);

function codesOf(error: MongoServerError): number[] {
  const codes = typeof error.code === 'number' ? [error.code] : [];
  if (error instanceof MongoBulkWriteError) for (const w of [error.writeErrors].flat()) codes.push(w.code);
  return codes;
}

/**
 * `Store.refusedInput` for MongoDB: the server's code, as a string, when it refused the input itself, or `BSONError`
 * when the driver could not encode it. MongoDB holds any number or string a validated batch can carry, but a key is a C
 * string: one with a NUL byte (a custom prop, an option name) fails before anything is sent.
 */
export function refusedInput(error: unknown): string | undefined {
  if (BSON.BSONError.isBSONError(error)) return 'BSONError';
  if (!(error instanceof MongoServerError)) return undefined;
  const code = codesOf(error).find((c) => REFUSED.has(c));
  return code === undefined ? undefined : String(code);
}

/**
 * A copy without the fields that are `null` or `undefined` (a NULL column is a missing field, `collections.ts`).
 * Shallow: values inside props and option values are kept as they came.
 */
export function compact<T extends object>(doc: { [K in keyof T]: T[K] | null | undefined }): T {
  const out: Record<string, unknown> = {};
  for (const key in doc) if (doc[key] != null) out[key] = doc[key];
  return out as T;
}

/**
 * Inserts documents some of which may be stored already (a retried batch), in one round trip, and returns the
 * positions of those inserted now. Any error but a duplicate key is thrown.
 */
export async function insertNew<T extends Document>(
  collection: Collection<T>,
  docs: OptionalUnlessRequiredId<T>[],
): Promise<Set<number>> {
  const inserted = new Set(docs.keys());
  if (docs.length === 0) return inserted;
  try {
    await collection.insertMany(docs, { ordered: false });
  } catch (error) {
    if (!(error instanceof MongoBulkWriteError) || !isDuplicateKey(error)) throw error;
    for (const w of [error.writeErrors].flat()) inserted.delete(w.index);
  }
  return inserted;
}
