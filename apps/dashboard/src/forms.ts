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

/** Why the activity log's filters can't be applied, or `''`: IDs are checked here, before the collector refuses them. */
export function activityFilterError(filters: { command: string; guild: string; user: string }): string {
  const guild = filters.guild.trim();
  const user = filters.user.trim();
  if (filters.command.trim().length > 32) return 'A command name is at most 32 characters.';
  if (guild !== '' && !isSnowflake(guild)) return 'A server ID is 17 to 19 digits.';
  if (user !== '' && !isSnowflake(user)) return 'A user ID is 17 to 19 digits.';
  return '';
}

/** Why a required-permissions value can't be saved, or `''`. Empty clears it. */
export function permissionBitsError(value: string): string {
  if (value === '') return '';
  if (!/^\d{1,19}$/.test(value) || BigInt(value) >= 2n ** 63n) {
    return 'Enter the permission bits as one whole number, as the Discord developer portal shows it.';
  }
  return '';
}
