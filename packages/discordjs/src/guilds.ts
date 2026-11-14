import { redactSecrets, uuidv7 } from '@shardlens/core';
import type { EventInput, GuildInfo } from '@shardlens/schema';
import type { Client, Guild } from 'discord.js';
import { shardForGuild } from './util.js';

/** The guild's shard; falls back to `(id >> 22) % shardCount` when discord.js has none. */
export function shardOf(g: Guild): number {
  if (typeof g.shardId === 'number' && g.shardId >= 0) return g.shardId;
  const count =
    g.client.shard?.count ?? (typeof g.client.options.shardCount === 'number' ? g.client.options.shardCount : 1);
  return shardForGuild(g.id, count) ?? 0;
}

/** The bot's permission bitfield in a server, or `0` when unknown (getters can throw before login). */
function botPermissions(g: Guild): string {
  try {
    return (g.client.user ? (g.members.me?.permissions.bitfield ?? 0n) : 0n).toString();
  } catch {
    return '0';
  }
}

/** Server profile from the discord.js cache (Guilds intent only). Nothing in it identifies a person. */
function guildInfo(g: Guild): GuildInfo {
  const channelCounts: Record<string, number> = {};
  for (const c of g.channels.cache.values()) {
    const key = String(c.type);
    channelCounts[key] = (channelCounts[key] ?? 0) + 1;
  }
  const premiumTier = Math.min(3, Math.max(0, Number(g.premiumTier) || 0));
  return {
    guild: g.id,
    name: redactSecrets(String(g.name ?? '')).slice(0, 100),
    icon: g.icon ? g.icon.slice(0, 64) : null,
    memberCount: Math.max(0, g.memberCount ?? 0),
    large: Boolean(g.large),
    preferredLocale: String(g.preferredLocale ?? 'en-US').slice(0, 10),
    features: [...(g.features ?? [])].map((f) => String(f).slice(0, 64)).slice(0, 64),
    premiumTier,
    boosts: g.premiumSubscriptionCount ?? null,
    verificationLevel: Number(g.verificationLevel) || 0,
    nsfwLevel: Number(g.nsfwLevel) || 0,
    mfaLevel: Number(g.mfaLevel) || 0,
    createdAt: g.createdTimestamp,
    joinedAt: g.joinedTimestamp > 0 ? g.joinedTimestamp : Date.now(),
    shard: shardOf(g),
    channelCounts,
    roleCount: g.roles.cache.size,
    emojiCount: g.emojis.cache.size,
    stickerCount: g.stickers.cache.size,
    botPermissions: botPermissions(g),
  };
}

export function guildJoin(g: Guild): EventInput {
  return { id: uuidv7(), ts: Date.now(), type: 'guild_join', info: guildInfo(g), detectedAtStartup: false };
}

export function guildUpdate(g: Guild): EventInput {
  return { id: uuidv7(), ts: Date.now(), type: 'guild_update', info: guildInfo(g) };
}

export function guildLeave(guildId: string): EventInput {
  return { id: uuidv7(), ts: Date.now(), type: 'guild_leave', guild: guildId, detectedAtStartup: false };
}

export function guildAvailability(g: Guild, available: boolean): EventInput {
  return { id: uuidv7(), ts: Date.now(), type: 'guild_availability', guild: g.id, available, shard: shardOf(g) };
}

/** One snapshot per shard, so each event stays under 2,500 servers. The collector diffs them per shard. */
export function guildSnapshots(guilds: Iterable<Guild>, shards: readonly number[], shardCount: number): EventInput[] {
  const byShard = new Map<number, string[]>(shards.map((s) => [s, []]));
  for (const g of guilds) byShard.get(shardOf(g))?.push(g.id);
  const now = Date.now();
  return [...byShard].map(([shard, ids]) => ({
    id: uuidv7(now),
    ts: now,
    type: 'guild_snapshot',
    shards: [shard],
    shardCount: Math.max(1, shardCount),
    guilds: ids.slice(0, 2500 * 16),
  }));
}

/**
 * `refreshGuildCounts`: one server per call, round robin, through `guild.fetch()`. Only the approximate member count
 * is used; presence counts are never read.
 */
export class CountRefresher {
  #queue: string[] = [];

  async next(client: Client): Promise<EventInput | undefined> {
    if (this.#queue.length === 0) this.#queue = [...client.guilds.cache.keys()];
    while (this.#queue.length > 0) {
      const id = this.#queue.shift() as string;
      const guild = client.guilds.cache.get(id);
      if (!guild?.available) continue;
      const fresh = await guild.fetch();
      const event = guildUpdate(fresh);
      const approx = fresh.approximateMemberCount;
      if (event.type === 'guild_update' && typeof approx === 'number') event.info.memberCount = Math.max(0, approx);
      return event;
    }
    return undefined;
  }
}

/**
 * Sends full server profiles after startup without flooding the queue: a few hundred per tick, and only while the
 * queue has room.
 */
export class ProfilePacer {
  #pending: string[] = [];

  reset(guildIds: Iterable<string>): void {
    this.#pending = [...guildIds];
  }

  get remaining(): number {
    return this.#pending.length;
  }

  tick(budget: number, emit: (guildId: string) => void): void {
    const n = Math.max(0, Math.min(budget, this.#pending.length));
    for (const id of this.#pending.splice(0, n)) emit(id);
  }
}
