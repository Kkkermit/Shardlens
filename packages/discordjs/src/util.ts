import { redactSecrets } from '@shardlens/core';

/** Map that keeps at most `max` entries, evicting the least recently set. */
export class LruMap<K, V> extends Map<K, V> {
  readonly max: number;
  readonly #batch: number;
  constructor(max: number) {
    super();
    this.max = max;
    this.#batch = Math.max(1, Math.ceil(max / 16));
  }
  override set(key: K, value: V): this {
    if (this.has(key)) this.delete(key);
    super.set(key, value);
    // A sixteenth of `max` at a time: V8 keeps a deleted entry's slot until the map is rehashed, and reaching the
    // oldest key steps over every such slot, so evicting one entry per insert took time in proportion to `max`.
    if (this.size > this.max) {
      let evict = this.size - this.max + this.#batch - 1;
      for (const oldest of this.keys()) {
        if (evict-- <= 0) break;
        this.delete(oldest);
      }
    }
    return this;
  }
}

/**
 * The wire format's `Snowflake` (`@shardlens/schema` is a dev dependency, for types only): an ID that fits a signed
 * 64-bit integer. An event with any other value in an ID field is rejected whole.
 */
export const SNOWFLAKE = /^(?:\d{17,18}|[1-8]\d{18}|9[01]\d{17})$/;

/** The collector stores durations and counts as 32-bit integers. */
const MAX_INT32 = 2 ** 31 - 1;

/** A finite number clamped to `[0, max]`, or `undefined` for anything else (NaN, Infinity, not a number). */
export function clamped(value: unknown, max: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(0, value)) : undefined;
}

/** {@link clamped}, rounded: for durations and counts, which the wire format takes as non-negative integers. */
export function clampedInt(value: unknown, max = MAX_INT32): number | undefined {
  const n = clamped(value, max);
  return n === undefined ? undefined : Math.round(n);
}

/** Shard a guild lives on: `(guild_id >> 22) % shard_count`. */
export function shardForGuild(guildId: string, shardCount: number): number | undefined {
  if (!SNOWFLAKE.test(guildId) || !(shardCount >= 1)) return undefined;
  return Number((BigInt(guildId) >> 22n) % BigInt(shardCount));
}

/**
 * Discord's route words are lower case, with hyphens, and only `oauth2` has a digit. Any other segment
 * is a value: an invite or template code, a token, an emoji, or whatever a bot put in its own path.
 */
const ROUTE_WORD = /^(?:[a-z][a-z-]*|oauth2|@me|@original|:[a-z]+)$/;

/**
 * Normalises a REST route before it is stored or used as a metric label, so it holds only route words and placeholders:
 * snowflakes become `:id` (including 20-digit IDs that `@discordjs/rest` does not template), invite and template codes
 * `:code`, webhook and interaction tokens `:token` and any other value `:param`. The query string is dropped, an
 * encoded `@` is written plainly (`/guilds/:id/members/@me`), and the result is capped at 200 characters.
 */
export function normaliseRoute(route: string): string {
  const segments = String(route).split('?')[0]!.replace(/%40/g, '@').split('/');
  const out = segments.map((segment, i) => {
    if (segment === '') return segment;
    if (/^\d{17,20}$/.test(segment)) return ':id';
    const previous = segments[i - 1];
    if (previous === 'invites' || previous === 'templates') return ':code';
    const owner = segments[i - 2];
    if (
      (owner === 'webhooks' || owner === 'interactions') &&
      (previous === ':id' || /^\d{17,20}$/.test(previous ?? ''))
    ) {
      return ':token';
    }
    return ROUTE_WORD.test(segment) ? segment : ':param';
  });
  return redactSecrets(out.join('/')).slice(0, 200);
}

declare const __SDK_VERSION__: string | undefined;
export const SDK_NAME = '@shardlens/discordjs';
export const SDK_VERSION: string = typeof __SDK_VERSION__ === 'string' ? __SDK_VERSION__ : '0.0.0-dev';
