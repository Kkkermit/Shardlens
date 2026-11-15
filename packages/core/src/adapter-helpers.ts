import { cutText, redactSecrets } from './normalise.js';

/** Class name of a thrown value, for the `errorClass` field. Never the message, which can hold user input. */
export function errorClass(error: unknown): string {
  if (error instanceof Error) {
    // Both can be overwritten with anything, including a getter that throws.
    try {
      for (const name of [error.constructor?.name, error.name]) {
        if (typeof name === 'string' && name.length > 0) return cutText(name, 64);
      }
    } catch {
      // fall through to the generic name
    }
    return 'Error';
  }
  return typeof error === 'object' && error !== null ? 'Object' : typeof error;
}

/** Discord's numeric JSON error code (`DiscordAPIError.code`), when the thrown value carries one. */
export function errorCode(error: unknown): number | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'number' && Number.isSafeInteger(code) ? code : undefined;
}

/** Copies an object without its `undefined` values, so events stay small on the wire. */
export function compact<T extends Record<string, unknown>>(value: T): T {
  // A fresh object rather than `delete`, which would push V8 objects into slow dictionary mode on the hot path.
  const out: Record<string, unknown> = {};
  for (const key in value) {
    const v = value[key];
    if (v !== undefined) out[key] = v;
  }
  return out as T;
}

/** A Discord avatar hash, or `undefined` for anything else (no avatar, or an unexpected shape). */
export function avatarHash(value: unknown): string | undefined {
  return typeof value === 'string' && /^(a_)?[0-9a-f]{32}$/.test(value) ? value : undefined;
}

/** Option types whose values point at someone or something: user, channel, role, mentionable and attachment. */
const IDENTIFYING_OPTION_TYPES: ReadonlySet<number> = new Set([6, 7, 8, 9, 11]);
const HAS_SNOWFLAKE = /\d{17,20}/;

/**
 * How an allow-listed option's value is recorded (`captureOptionValues`), or `undefined` when it must not be: never a
 * user, channel, role, mentionable or attachment option, nor a value holding a Discord ID, which a user can type.
 * Strings have secrets redacted and are cut to 100 characters.
 */
export function recordedOptionValue(value: unknown, type?: number): string | number | boolean | undefined {
  if (type !== undefined && IDENTIFYING_OPTION_TYPES.has(type)) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) && Math.abs(value) < 1e16 ? value : undefined;
  if (typeof value !== 'string') return undefined;
  // Cut before redacting, which has to look at all of it: a value can be 6,000 characters long.
  const head = value.slice(0, 512);
  return HAS_SNOWFLAKE.test(head) ? undefined : cutText(redactSecrets(head), 100);
}
