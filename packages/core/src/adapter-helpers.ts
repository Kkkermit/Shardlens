/** Class name of a thrown value, for the `errorClass` field. Never the message, which can hold user input. */
export function errorClass(error: unknown): string {
  if (error instanceof Error) {
    // Both can be overwritten with anything, including a getter that throws.
    try {
      for (const name of [error.constructor?.name, error.name]) {
        if (typeof name === 'string' && name.length > 0) return name.slice(0, 64);
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
  return typeof code === 'number' && Number.isInteger(code) ? code : undefined;
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
