/**
 * A value as PostgreSQL's `jsonb` columns give it back (settings, log details): written as JSON, so `undefined` fields
 * are dropped and dates become strings, instead of BSON keeping them as they were.
 */
export function asJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
