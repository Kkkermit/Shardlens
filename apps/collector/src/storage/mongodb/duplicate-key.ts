import { MongoServerError } from 'mongodb';

/** The server refused a write because a unique index (or `_id`) already holds the value. */
export function isDuplicateKey(error: unknown): boolean {
  return error instanceof MongoServerError && error.code === 11000;
}
