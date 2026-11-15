/** A Discord ID the collector accepts: 17 to 19 digits, within a signed 64-bit integer (the API's own rule). */
const SNOWFLAKE = /^(?:\d{17,18}|[1-8]\d{18}|9[01]\d{17})$/;

export const isSnowflake = (value: string) => SNOWFLAKE.test(value);

/** The fields of `next` that differ from `current`, so a save sends only what was changed. */
export function changedFields<T extends object>(current: T, next: Partial<T>): Partial<T> {
  const changed: Partial<T> = {};
  for (const key of Object.keys(next) as (keyof T)[]) {
    if (JSON.stringify(next[key]) !== JSON.stringify(current[key])) changed[key] = next[key];
  }
  return changed;
}
