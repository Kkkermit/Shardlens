import { MongoBulkWriteError, MongoServerError } from 'mongodb';

const DUPLICATE_KEY = 11000;

/**
 * The server refused a write only because a unique index (or `_id`) already holds the value: for a bulk write, every
 * write that failed failed on that.
 */
export function isDuplicateKey(error: unknown): boolean {
  if (error instanceof MongoBulkWriteError) {
    const failed = [error.writeErrors].flat();
    return failed.length > 0 && failed.every((w) => w.code === DUPLICATE_KEY);
  }
  return error instanceof MongoServerError && error.code === DUPLICATE_KEY;
}
