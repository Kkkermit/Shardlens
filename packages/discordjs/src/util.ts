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
 * Normalises a REST route before it is stored: snowflakes become `:id` (including 20-digit IDs that `@discordjs/rest`
 * does not template), an encoded `@` is written plainly (`/guilds/:id/members/@me`), anything token-shaped is
 * redacted, and the result is capped at 200 characters.
 */
export function normaliseRoute(route: string): string {
  return redactSecrets(
    String(route)
      .replace(/\d{17,20}/g, ':id')
      .replace(/%40/g, '@'),
  ).slice(0, 200);
}

declare const __SDK_VERSION__: string | undefined;
export const SDK_NAME = '@shardlens/discordjs';
export const SDK_VERSION: string = typeof __SDK_VERSION__ === 'string' ? __SDK_VERSION__ : '0.0.0-dev';
