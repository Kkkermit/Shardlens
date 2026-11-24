import type { GuildInfo } from '@shardlens/schema';
import { insertRows, type Tx } from '../../../db.js';
import { GUILD_EVENT } from '../../../ingest/codes.js';

const PROFILE_COLUMNS = `name = EXCLUDED.name, icon = EXCLUDED.icon, member_count = EXCLUDED.member_count,
  large = EXCLUDED.large, preferred_locale = EXCLUDED.preferred_locale, features = EXCLUDED.features,
  premium_tier = EXCLUDED.premium_tier, boosts = EXCLUDED.boosts, verification_level = EXCLUDED.verification_level,
  nsfw_level = EXCLUDED.nsfw_level, mfa_level = EXCLUDED.mfa_level, created_at = EXCLUDED.created_at,
  shard = EXCLUDED.shard, channel_counts = EXCLUDED.channel_counts, role_count = EXCLUDED.role_count,
  emoji_count = EXCLUDED.emoji_count, sticker_count = EXCLUDED.sticker_count, bot_permissions = EXCLUDED.bot_permissions,
  updated_at = now()`;

function profileValues(appId: string, info: GuildInfo, joinedAt: Date): unknown[] {
  return [
    appId,
    info.guild,
    info.name,
    info.icon,
    info.memberCount,
    info.memberCount,
    info.large,
    info.preferredLocale,
    info.features,
    info.premiumTier,
    info.boosts,
    info.verificationLevel,
    info.nsfwLevel,
    info.mfaLevel,
    new Date(info.createdAt),
    joinedAt,
    info.shard,
    JSON.stringify(info.channelCounts),
    info.roleCount,
    info.emojiCount,
    info.stickerCount,
    info.botPermissions,
  ];
}

const PROFILE_INSERT = `INSERT INTO guilds (app_id, guild_id, name, icon, member_count, size_at_join, large, preferred_locale,
  features, premium_tier, boosts, verification_level, nsfw_level, mfa_level, created_at, joined_at, shard,
  channel_counts, role_count, emoji_count, sticker_count, bot_permissions, baseline)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,`;

/** One entry in a server's history. `false` when it is already there (a retried event). */
export async function recordGuildEvent(
  tx: Tx,
  appId: string,
  guildId: string,
  ts: Date,
  kind: (typeof GUILD_EVENT)[keyof typeof GUILD_EVENT],
  detected: boolean,
): Promise<boolean> {
  const inserted = await insertRows(
    tx,
    'guild_events',
    ['app_id', 'guild_id', 'ts', 'kind', 'detected_at_startup'],
    [[appId, guildId, ts, kind, detected]],
  );
  return inserted > 0;
}

/** A server added the bot while it was online. Duplicate (retried) joins are ignored. */
export async function applyGuildJoin(tx: Tx, appId: string, ts: Date, info: GuildInfo, detected: boolean) {
  if (!(await recordGuildEvent(tx, appId, info.guild, ts, GUILD_EVENT.join, detected))) return false;
  await tx.query(
    `${PROFILE_INSERT} false)
     ON CONFLICT (app_id, guild_id) DO UPDATE SET ${PROFILE_COLUMNS},
       joined_at = EXCLUDED.joined_at, left_at = NULL, size_at_join = EXCLUDED.size_at_join,
       detected_at_startup = $23, baseline = false, first_command_at = NULL, last_command_at = NULL`,
    [...profileValues(appId, info, ts), detected],
  );
  return true;
}

/**
 * Profile refresh. Creates the row as an existing install if the server isn't known yet: with several shards, a profile
 * can arrive before the last shard's first snapshot, and a join always comes as a guild_join.
 */
export async function applyGuildUpdate(tx: Tx, appId: string, info: GuildInfo) {
  await tx.query(
    `${PROFILE_INSERT} true) ON CONFLICT (app_id, guild_id) DO UPDATE SET ${PROFILE_COLUMNS},
       size_at_join = coalesce(guilds.size_at_join, EXCLUDED.size_at_join),
       -- Servers imported by the first snapshot only know the snapshot time; the profile has Discord's join time.
       joined_at = CASE WHEN guilds.baseline THEN EXCLUDED.joined_at ELSE guilds.joined_at END`,
    profileValues(appId, info, new Date(info.joinedAt)),
  );
}

export async function applyGuildLeave(tx: Tx, appId: string, ts: Date, guildId: string, detected: boolean) {
  if (!(await recordGuildEvent(tx, appId, guildId, ts, GUILD_EVENT.leave, detected))) return false;
  await tx.query(
    'UPDATE guilds SET left_at = $3, updated_at = now() WHERE app_id = $1 AND guild_id = $2 AND left_at IS NULL',
    [appId, guildId, ts],
  );
  return true;
}

/**
 * Diffs a startup snapshot against known servers, per shard, to catch joins and removals that happened while the bot
 * was offline. Shard membership is computed from the ID, so it never depends on stored state. When the shard layout
 * changes, nothing is diffed until every shard has reported. The first complete snapshot is a baseline, not joins.
 */
export async function applySnapshot(
  tx: Tx,
  appId: string,
  ts: Date,
  snap: { shards: number[]; shardCount: number; guilds: string[] },
): Promise<{ joins: number; leaves: number; pending: boolean }> {
  const app = await tx.query<{ shard_count: number | null; baseline_done: boolean }>(
    'SELECT shard_count, baseline_done FROM apps WHERE app_id = $1 FOR UPDATE',
    [appId],
  );
  const current = app.rows[0];
  if (!current) return { joins: 0, leaves: 0, pending: false };
  const n = snap.shardCount;
  // A shard outside the layout can't be right, and counting it would complete the layout before every shard reported.
  const shards = snap.shards.filter((shard) => shard < n);
  if (shards.length === 0) return { joins: 0, leaves: 0, pending: false };

  if (current.shard_count !== n || !current.baseline_done) {
    for (const shard of shards) {
      await tx.query(
        `INSERT INTO snapshot_pending (app_id, shard_count, shard, guilds, ts) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (app_id, shard_count, shard) DO UPDATE SET guilds = EXCLUDED.guilds, ts = EXCLUDED.ts`,
        [appId, n, shard, snap.guilds, ts],
      );
    }
    const reported = await tx.query<{ shard: number; guilds: string[]; ts: Date }>(
      `SELECT shard, guilds::text[] AS guilds, ts FROM snapshot_pending
        WHERE app_id = $1 AND shard_count = $2 AND shard < $2`,
      [appId, n],
    );
    if (reported.rows.length < n) return { joins: 0, leaves: 0, pending: true };
    await tx.query('DELETE FROM snapshot_pending WHERE app_id = $1', [appId]);
    await tx.query('UPDATE apps SET shard_count = $2, baseline_done = true WHERE app_id = $1', [appId, n]);
    // Each shard against its own snapshot: one taken minutes ago knows nothing of the joins and leaves since.
    const total = { joins: 0, leaves: 0, pending: false };
    for (const row of reported.rows) {
      const own = row.guilds.filter((guild) => shardForGuild(guild, n) === row.shard);
      const result = await diff(tx, appId, ts, n, [row.shard], own, !current.baseline_done, row.ts);
      total.joins += result.joins;
      total.leaves += result.leaves;
    }
    return total;
  }
  return diff(tx, appId, ts, n, shards, snap.guilds, false, ts);
}

const shardForGuild = (guild: string, shardCount: number) => Number((BigInt(guild) >> 22n) % BigInt(shardCount));

/**
 * Joins and removals the snapshot shows, for the given shards. A server whose join or leave was recorded after the
 * snapshot was taken (`takenAt`) is left alone: that event is newer than the snapshot's view of it.
 */
async function diff(
  tx: Tx,
  appId: string,
  ts: Date,
  shardCount: number,
  shards: number[],
  present: string[],
  baseline: boolean,
  takenAt: Date,
): Promise<{ joins: number; leaves: number; pending: boolean }> {
  const gone = await tx.query<{ guild_id: string }>(
    `SELECT guild_id FROM guilds g
      WHERE app_id = $1 AND left_at IS NULL AND ((guild_id >> 22) % $2)::int = ANY($3::int[])
        AND NOT (guild_id = ANY($4::bigint[]))
        AND NOT EXISTS (SELECT 1 FROM guild_events e WHERE e.app_id = g.app_id AND e.guild_id = g.guild_id
                          AND e.kind IN (${GUILD_EVENT.join}, ${GUILD_EVENT.leave}) AND e.ts > $5)`,
    [appId, shardCount, shards, present, takenAt],
  );
  let leaves = 0;
  if (!baseline) {
    for (const { guild_id } of gone.rows) if (await applyGuildLeave(tx, appId, ts, guild_id, true)) leaves++;
  }

  const known = await tx.query<{ guild_id: string }>(
    'SELECT guild_id FROM guilds WHERE app_id = $1 AND left_at IS NULL AND guild_id = ANY($2::bigint[])',
    [appId, present],
  );
  const newer = await tx.query<{ guild_id: string }>(
    `SELECT DISTINCT guild_id::text AS guild_id FROM guild_events
      WHERE app_id = $1 AND guild_id = ANY($2::bigint[]) AND kind IN (${GUILD_EVENT.join}, ${GUILD_EVENT.leave}) AND ts > $3`,
    [appId, present, takenAt],
  );
  const skip = new Set([...known.rows, ...newer.rows].map((r) => r.guild_id));
  const added = present.filter((g) => !skip.has(g));
  let joins = 0;
  for (const guildId of added) {
    if (baseline) {
      // Existing install: profile arrives shortly in a guild_update.
      await tx.query(
        `INSERT INTO guilds (app_id, guild_id, joined_at, baseline) VALUES ($1, $2, $3, true)
         ON CONFLICT (app_id, guild_id) DO NOTHING`,
        [appId, guildId, ts],
      );
      continue;
    }
    if (!(await recordGuildEvent(tx, appId, guildId, ts, GUILD_EVENT.join, true))) continue;
    await tx.query(
      `INSERT INTO guilds (app_id, guild_id, joined_at, detected_at_startup) VALUES ($1, $2, $3, true)
       ON CONFLICT (app_id, guild_id) DO UPDATE SET joined_at = EXCLUDED.joined_at, left_at = NULL,
         detected_at_startup = true, baseline = false, size_at_join = NULL,
         first_command_at = NULL, last_command_at = NULL`,
      [appId, guildId, ts],
    );
    joins++;
  }
  return { joins, leaves, pending: false };
}
