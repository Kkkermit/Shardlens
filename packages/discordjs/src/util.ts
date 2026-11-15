import { redactSecrets } from '@shardlens/core';

/** Map that evicts its oldest entry past `max` entries. */
export class LruMap<K, V> extends Map<K, V> {
  readonly max: number;
  constructor(max: number) {
    super();
    this.max = max;
  }
  override set(key: K, value: V): this {
    if (this.has(key)) this.delete(key);
    super.set(key, value);
    if (this.size > this.max) this.delete(this.keys().next().value as K);
    return this;
  }
}

/** Shard a guild lives on: `(guild_id >> 22) % shard_count`. */
export function shardForGuild(guildId: string, shardCount: number): number | undefined {
  if (!/^\d{17,20}$/.test(guildId) || !(shardCount >= 1)) return undefined;
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
