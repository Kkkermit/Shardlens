/** The longest command name the SDK sends and the collector accepts (Discord's own limit is 32 too). */
export const MAX_COMMAND_NAME = 32;

/** How far back a command with no runs in the chosen range is looked for, before its page says it doesn't exist. */
export const KNOWN_COMMAND_DAYS = 90;

/**
 * Whether a command exists, from the command list over {@link KNOWN_COMMAND_DAYS} days, which holds every command
 * that ran in that time and every registered one, used or not. `undefined` while the list isn't known.
 */
export function commandFound(name: string, rows: readonly { command: string }[] | undefined): boolean | undefined {
  return rows === undefined ? undefined : rows.some((row) => row.command === name);
}
