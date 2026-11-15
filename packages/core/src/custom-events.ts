import { cutText, redactSecrets } from './normalise.js';

export type CustomPropValue = string | number | boolean | null;

export type CustomProps = Record<string, CustomPropValue>;

/**
 * Register your custom events here for typed `track()` calls. Name the Shardlens package your bot installs
 * (`@shardlens/discordjs` or `@shardlens/http`): with pnpm, a bot can't see `@shardlens/core` itself.
 *
 * @example
 * ```ts
 * declare module '@shardlens/discordjs' {
 *   interface CustomEvents {
 *     ticket_opened: { category: 'billing' | 'support' };
 *   }
 * }
 * lens.track('ticket_opened', { category: 'billing' });
 * ```
 */
// biome-ignore lint/suspicious/noEmptyInterface: augmented by users through declaration merging
export interface CustomEvents {}

/** Event names accepted by `track()`: your registered names, or any string if you registered none. */
export type CustomEventName = [keyof CustomEvents] extends [never] ? string : keyof CustomEvents & string;

export type CustomEventProps<N extends string> = N extends keyof CustomEvents ? CustomEvents[N] : CustomProps;

/** Custom event names: lower snake case, starting with a letter, up to 64 characters. */
export const CUSTOM_EVENT_NAME = /^[a-z][a-z0-9_]{0,63}$/;

export const MAX_CUSTOM_PROPS_BYTES = 2048;

/**
 * Copies custom event properties if they fit the limits (2 KB, 64-character keys, 256-character strings), with secrets
 * redacted and NUL or broken characters in keys and strings replaced.
 */
export function sanitiseCustomProps(props: unknown): CustomProps | undefined {
  if (props === undefined) return {};
  if (props === null || typeof props !== 'object' || Array.isArray(props)) return undefined;
  const out: CustomProps = {};
  for (const [rawKey, value] of Object.entries(props)) {
    if (rawKey.length > 64) return undefined;
    const key = cutText(rawKey, 64);
    if (value === null || typeof value === 'boolean') out[key] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'string' && value.length <= 256) out[key] = cutText(redactSecrets(value), 256);
    else return undefined;
  }
  if (new TextEncoder().encode(JSON.stringify(out)).byteLength > MAX_CUSTOM_PROPS_BYTES) return undefined;
  return out;
}
