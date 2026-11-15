const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const DIGITS = /\d+/g;

export const MAX_CUSTOM_ID_LENGTH = 100;

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * At most `max` UTF-16 units of `text`, cut so it never ends halfway through a character, with NUL and any lone
 * surrogate replaced by U+FFFD: PostgreSQL can't store either, so the collector refuses an event holding one.
 */
export function cutText(text: string, max: number): string {
  let out = text.length > max ? text.slice(0, max) : text;
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out.replace(LONE_SURROGATE, '\ufffd').replaceAll('\0', '\ufffd');
}

/**
 * Turns a custom ID into a pattern without IDs or numbers: `ticket:close:112233445566778899` → `ticket:close:*`. UUIDs
 * go first, as a whole: their digits alone would leave the letters behind.
 */
export function normaliseCustomId(customId: string): string {
  return cutText(customId, MAX_CUSTOM_ID_LENGTH).replace(UUID, '*').replace(DIGITS, '*');
}

/** Deliberately broad: a false positive costs a little error detail, a false negative leaks a credential. */
const SECRET_PATTERNS: readonly [RegExp, string][] = [
  // Discord bot tokens: base64(user ID).timestamp.HMAC. Bots with 17-digit IDs have a 23-character first segment.
  // Only tried where a run of token characters starts, so a long run is scanned once, not once per position.
  [/(?<![\w-])[\w-]{23,}\.[\w-]{6,7}\.[\w-]{27,}/g, '[token]'],
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
