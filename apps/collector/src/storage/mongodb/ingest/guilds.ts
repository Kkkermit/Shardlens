import type { Event, GuildInfo } from '@shardlens/schema';
import type { AnyBulkWriteOperation, Document } from 'mongodb';
import { GUILD_EVENT } from '../../../ingest/codes.js';
import type { WriteResult } from '../../store.js';
import type { GuildDoc, GuildEventDoc } from '../collections.js';
import type { Mongo } from '../connect.js';
import { compact, insertNew } from '../writes.js';

type GuildKind = (typeof GUILD_EVENT)[keyof typeof GUILD_EVENT];

export const guildKey = (appId: string, guildId: string): GuildDoc['_id'] => ({ appId, guildId });

/** One entry in a server's history. */
export interface Lifecycle {
  guild: string;
  ts: Date;
  kind: GuildKind;
  detected: boolean;
}

const changesServer = (kind: GuildKind) => kind === GUILD_EVENT.join || kind === GUILD_EVENT.leave;
const entryKey = (id: GuildEventDoc['_id']) => `${id.guildId}\0${id.ts.getTime()}\0${id.kind}`;

/**
 * Records history entries in one round trip. `fresh`: stored now (a duplicate is a retried event). `apply`: to apply
 * to its server now. A join or leave is stored `pending` until {@link settle} clears it, so a batch retried after
 * failing in between applies it then; one applied already, or recorded earlier in the same call, is not applied again.
 */
export async function recordHistory(
  m: Mongo,
  appId: string,
  entries: readonly Lifecycle[],
): Promise<{ fresh: boolean[]; apply: boolean[] }> {
  const docs = entries.map((e) =>
    compact<GuildEventDoc>({
      _id: { appId, guildId: e.guild, ts: e.ts, kind: e.kind },
      detectedAtStartup: e.detected,
      pending: changesServer(e.kind) ? true : undefined,
    }),
  );
  const inserted = await insertNew(m.c.guildEvents, docs);
  const retried = docs.filter((d, i) => d.pending && !inserted.has(i));
  const unapplied =
    retried.length === 0
      ? new Set<string>()
      : new Set(
          (
            await m.c.guildEvents
              .find({ _id: { $in: retried.map((d) => d._id) }, pending: true }, { projection: { _id: 1 } })
              .toArray()
          ).map((d) => entryKey(d._id)),
        );
  const seen = new Set<string>();
  const apply = docs.map((d, i) => {
    const key = entryKey(d._id);
    const first = !seen.has(key);
    seen.add(key);
    return first && d.pending === true && (inserted.has(i) || unapplied.has(key));
  });
  return { fresh: docs.map((_, i) => inserted.has(i)), apply };
}

/** Marks applied joins and leaves as no longer pending. */
export async function settle(m: Mongo, appId: string, applied: readonly Lifecycle[]): Promise<void> {
  if (applied.length === 0) return;
  await m.c.guildEvents.updateMany(
    { _id: { $in: applied.map((e) => ({ appId, guildId: e.guild, ts: e.ts, kind: e.kind })) } },
    { $unset: { pending: '' } },
  );
}

/** A value from the batch inside an update pipeline, where a string starting with `$` would name a field. */
const literal = (value: unknown) => (value === null ? '$$REMOVE' : { $literal: value });
const missing = (field: string) => ({ $eq: [{ $type: field }, 'missing'] });

function profile(info: GuildInfo, now: Date): Document {
  return {
    name: literal(info.name),
    icon: literal(info.icon),
    memberCount: literal(info.memberCount),
    large: literal(info.large),
    preferredLocale: literal(info.preferredLocale),
    features: literal(info.features),
    premiumTier: literal(info.premiumTier),
    boosts: literal(info.boosts),
    verificationLevel: literal(info.verificationLevel),
    nsfwLevel: literal(info.nsfwLevel),
    mfaLevel: literal(info.mfaLevel),
    createdAt: literal(new Date(info.createdAt)),
    shard: literal(info.shard),
    channelCounts: literal(info.channelCounts),
    roleCount: literal(info.roleCount),
    emojiCount: literal(info.emojiCount),
    stickerCount: literal(info.stickerCount),
    // PostgreSQL keeps the bits as a number: leading zeros go.
    botPermissions: literal(BigInt(info.botPermissions).toString()),
    updatedAt: literal(now),
  };
}

/** A server added the bot while it was online. A server new to the store keeps `detectedAtStartup` false. */
function join(appId: string, ts: Date, info: GuildInfo, detected: boolean, now: Date): AnyBulkWriteOperation<GuildDoc> {
  return {
    updateOne: {
      filter: { _id: guildKey(appId, info.guild) },
      update: [
        {
          $set: {
            ...profile(info, now),
            detectedAtStartup: { $cond: [missing('$joinedAt'), false, detected] },
            joinedAt: literal(ts),
            sizeAtJoin: literal(info.memberCount),
            baseline: false,
          },
        },
        { $unset: ['leftAt', 'firstCommandAt', 'lastCommandAt'] },
      ],
      upsert: true,
    },
  };
}

/**
 * Profile refresh. Creates the server as an existing install if it isn't known yet: with several shards, a profile can
 * arrive before the last shard's first snapshot, and a join always comes as a guild_join.
 */
function update(appId: string, info: GuildInfo, now: Date): AnyBulkWriteOperation<GuildDoc> {
  return {
    updateOne: {
      filter: { _id: guildKey(appId, info.guild) },
      update: [
        {
          $set: {
            ...profile(info, now),
            sizeAtJoin: { $ifNull: ['$sizeAtJoin', literal(info.memberCount)] },
            // Servers imported by the first snapshot only know the snapshot time; the profile has Discord's join time.
            joinedAt: {
              $cond: [
                { $or: [missing('$joinedAt'), { $eq: ['$baseline', true] }] },
                literal(new Date(info.joinedAt)),
                '$joinedAt',
              ],
            },
            baseline: { $ifNull: ['$baseline', true] },
            detectedAtStartup: { $ifNull: ['$detectedAtStartup', false] },
          },
        },
      ],
      upsert: true,
    },
  };
}

export function leave(appId: string, guildId: string, ts: Date, now: Date): AnyBulkWriteOperation<GuildDoc> {
  return {
    updateOne: {
      filter: { _id: guildKey(appId, guildId), leftAt: { $exists: false } },
      update: { $set: { leftAt: ts, updatedAt: now } },
    },
  };
}

type GuildEvent = Extract<Event, { type: 'guild_join' | 'guild_update' | 'guild_leave' | 'guild_availability' }>;

/**
 * Joins, profiles, leaves and availability changes that came one after another in a batch: their history in one
 * round trip, then their changes to servers in one ordered bulk write, so they apply in batch order.
 */
export async function applyGuildEvents(
  m: Mongo,
  appId: string,
  events: readonly GuildEvent[],
  now: Date,
  result: WriteResult,
): Promise<void> {
  const entries: Lifecycle[] = [];
  const entryOf = events.map((e) => {
    if (e.type === 'guild_update') return -1;
    const ts = new Date(e.ts);
    if (e.type === 'guild_join')
      entries.push({ guild: e.info.guild, ts, kind: GUILD_EVENT.join, detected: e.detectedAtStartup });
    else if (e.type === 'guild_leave')
      entries.push({ guild: e.guild, ts, kind: GUILD_EVENT.leave, detected: e.detectedAtStartup });
    else
      entries.push({
        guild: e.guild,
        ts,
        kind: e.available ? GUILD_EVENT.available : GUILD_EVENT.unavailable,
        detected: false,
      });
    return entries.length - 1;
  });
  const { fresh, apply } = await recordHistory(m, appId, entries);
  const ops: AnyBulkWriteOperation<GuildDoc>[] = [];
  events.forEach((e, i) => {
    const entry = entryOf[i]!;
    if (entry === -1) result.accepted++;
    else if (fresh[entry]) result.accepted++;
    else result.duplicates++;
    if (e.type === 'guild_update') ops.push(update(appId, e.info, now));
    else if (!apply[entry]) return;
    else if (e.type === 'guild_join') ops.push(join(appId, new Date(e.ts), e.info, e.detectedAtStartup, now));
    else if (e.type === 'guild_leave') ops.push(leave(appId, e.guild, new Date(e.ts), now));
  });
  if (ops.length > 0) await m.c.guilds.bulkWrite(ops, { ordered: true });
  await settle(
    m,
    appId,
    entries.filter((_, i) => apply[i]),
  );
}

/**
 * Each server's first and last command, from the batch's commands run in it while the bot was there (or before it
 * left: a batch isn't in event order, and later runs are a user install used in a server the bot has left).
 */
export async function recordCommandActivity(
  m: Mongo,
  appId: string,
  runs: readonly { guild: string; ts: Date }[],
): Promise<void> {
  const byGuild = new Map<string, Date[]>();
  for (const { guild, ts } of runs) {
    const times = byGuild.get(guild);
    if (times) times.push(ts);
    else byGuild.set(guild, [ts]);
  }
  if (byGuild.size === 0) return;
  await m.c.guilds.bulkWrite(
    [...byGuild].map(([guild, times]) => ({
      updateOne: {
        filter: { _id: guildKey(appId, guild) },
        update: [
          {
            $set: {
              _runs: {
                $filter: {
                  input: { $literal: times },
                  cond: { $or: [missing('$leftAt'), { $lte: ['$$this', '$leftAt'] }] },
                },
              },
            },
          },
          {
            $set: {
              firstCommandAt: { $ifNull: [{ $min: [{ $min: '$_runs' }, '$firstCommandAt'] }, '$$REMOVE'] },
              lastCommandAt: { $ifNull: [{ $max: [{ $max: '$_runs' }, '$lastCommandAt'] }, '$$REMOVE'] },
            },
          },
          { $unset: '_runs' },
        ],
      },
    })),
    { ordered: false },
  );
}
