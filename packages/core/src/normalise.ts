const SNOWFLAKE = /\d{17,20}/g;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const DIGITS = /\d+/g;

export const MAX_CUSTOM_ID_LENGTH = 100;

/** Turns a custom ID into a pattern without IDs or numbers: `ticket:close:112233445566778899` → `ticket:close:*`. */
export function normaliseCustomId(customId: string): string {
  return customId.slice(0, MAX_CUSTOM_ID_LENGTH).replace(SNOWFLAKE, '*').replace(UUID, '*').replace(DIGITS, '*');
}

/** Deliberately broad: a false positive costs a little error detail, a false negative leaks a credential. */
const SECRET_PATTERNS: readonly [RegExp, string][] = [
  // Discord bot tokens: base64(user ID).timestamp.HMAC. Bots with 17-digit IDs have a 23-character first segment.
  [/[\w-]{23,}\.[\w-]{6,7}\.[\w-]{27,}/g, '[token]'],
  [/\/(webhooks|interactions)\/(\d{17,20})\/[\w.-]{20,}/g, '/$1/$2/[token]'],
  [/\b(Bot|Bearer)\s+[\w.~+/-]{20,}=*/g, '$1 [token]'],
  [/\bslk_(ingest|read)_[\w-]{20,}/g, 'slk_$1_[key]'],
];

/**
 * Removes anything that looks like a Discord bot token, an interaction or webhook token, an `Authorization` value or
 * a Shardlens API key. Every piece of error text passes through this before it is sent or logged.
 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}
