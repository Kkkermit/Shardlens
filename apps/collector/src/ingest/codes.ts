/** Small-integer encodings used in the database (keep in step with the column comments in 001_init.sql). */

export const KIND = {
  chat_input: 1,
  user_context: 2,
  message_context: 3,
  primary_entry_point: 4,
  button: 5,
  select: 6,
  modal_submit: 7,
  autocomplete: 8,
  /** Not an interaction: a message (prefix) command the bot reported. No locale, response or deadline. */
  message_command: 9,
} as const;

/** Kinds that are commands rather than components, modals or autocomplete: what the `interactions` metric counts. */
export const COMMAND_KINDS: readonly number[] = [
  KIND.chat_input,
  KIND.user_context,
  KIND.message_context,
  KIND.primary_entry_point,
  KIND.message_command,
];

/** {@link COMMAND_KINDS} as an SQL list. */
export const COMMAND_KINDS_SQL = `(${COMMAND_KINDS.join(', ')})`;

/**
 * For figures only Discord interactions have (response deadline, defer and ephemeral rates, entitlements): leaves out
 * message commands, which have no response and would dilute them.
 */
export const INTERACTIONS_ONLY_SQL = `kind <> ${KIND.message_command}`;

export const OUTCOME = { ok: 0, error: 1, timeout: 2, no_response: 3 } as const;
export const INSTALL = { guild: 0, user: 1, both: 2 } as const;
export const MEMBER_TIER = { dm: 0, member: 1, manager: 2, admin: 3 } as const;
export const COMMAND_SCOPE = { global: 0, guild: 1 } as const;
export const GUILD_EVENT = { join: 1, leave: 2, unavailable: 3, available: 4 } as const;

function invert<T extends Record<string, number>>(map: T): Record<number, keyof T & string> {
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [v, k])) as Record<number, keyof T & string>;
}

export const KIND_NAME = invert(KIND);
export const OUTCOME_NAME = invert(OUTCOME);
export const INSTALL_NAME = invert(INSTALL);
export const MEMBER_TIER_NAME = invert(MEMBER_TIER);

/** `h1:<period>:<32 hex>` → period label and 16 raw bytes. */
export function parseUserHash(hash: string): { period: string; bytes: Buffer } | undefined {
  const m = /^h1:([0-9A-Za-z-]+):([0-9a-f]{32})$/.exec(hash);
  if (!m) return undefined;
  return { period: m[1]!, bytes: Buffer.from(m[2]!, 'hex') };
}
