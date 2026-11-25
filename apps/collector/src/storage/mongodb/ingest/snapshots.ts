import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { type AnyBulkWriteOperation, Long } from 'mongodb';
import { GUILD_EVENT } from '../../../ingest/codes.js';
import type { GuildDoc } from '../collections.js';
import type { Mongo } from '../connect.js';
import { isDuplicateKey } from '../writes.js';
import { guildKey, type Lifecycle, leave, recordHistory, settle } from './guilds.js';

/** How long a snapshot lease lasts: far longer than applying one takes, so it only runs out when its holder died. */
const LEASE_MS = 60_000;
/** How long a batch waits for another batch's snapshot before failing, to be retried by the SDK. */
const WAIT_MS = 20_000;

const SHARD_UNIT = 4_194_304; // 2^22: a snowflake's low 22 bits are not its time.

/**
 * Runs `fn` holding the app's snapshot lease (`shardlens_leases`, `snapshot:<app>`), MongoDB's stand-in for the row
 * lock PostgreSQL takes on the app: two shards' snapshots must not both complete a layout, or both diff one shard.
 */
async function withSnapshotLease<T>(m: Mongo, appId: string, fn: () => Promise<T>): Promise<T> {
  const _id = `snapshot:${appId}`;
  const holder = randomUUID();
  const deadline = Date.now() + WAIT_MS;
  for (let delay = 20; ; delay = Math.min(delay * 2, 500)) {
    const now = new Date();
    try {
      // Matches only a lease that ran out; while another holds one, the insert it falls back to is a duplicate.
      await m.c.leases.updateOne(
        { _id, expiresAt: { $lte: now } },
        { $set: { holder, expiresAt: new Date(now.getTime() + LEASE_MS) } },
        { upsert: true },
      );
      break;
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
    }
    if (Date.now() + delay > deadline) throw new Error(`MongoStore: app ${appId}'s snapshot lease is still held`);
    await sleep(delay);
  }
  try {
    return await fn();
  } finally {
    await m.c.leases.deleteOne({ _id, holder }).catch(() => undefined);
  }
}

const shardForGuild = (guild: string, shardCount: number) => Number((BigInt(guild) >> 22n) % BigInt(shardCount));

/**
 * `(id >> 22) % n` without a shift operator: `(id mod n·2^22) div 2^22` in 64-bit integers, which stay exact where a
 * double would round the ID.
 */
const shardOf = (field: string, shardCount: number) => ({
  $toInt: {
    $floor: { $divide: [{ $mod: [{ $toLong: field }, Long.fromNumber(shardCount * SHARD_UNIT)] }, SHARD_UNIT] },
  },
});

/**
 * Diffs a startup snapshot against known servers, per shard, to catch joins and removals that happened while the bot
 * was offline. Shard membership is computed from the ID, so it never depends on stored state. When the shard layout
 * changes, nothing is diffed until every shard has reported. The first complete snapshot is a baseline, not joins.
 *
 * No transaction holds the steps together: the diffs come first and the layout is recorded last, and every step is
 * idempotent, so a batch retried after failing partway finishes the work.
 */
export async function applySnapshot(
  m: Mongo,
  appId: string,
  ts: Date,
  snap: { shards: number[]; shardCount: number; guilds: string[] },
  now: Date,
): Promise<void> {
  const n = snap.shardCount;
  // A shard outside the layout can't be right, and counting it would complete the layout before every shard reported.
  const shards = snap.shards.filter((shard) => shard < n);
  if (shards.length === 0) return;
  await withSnapshotLease(m, appId, async () => {
    const app = await m.c.apps.findOne({ _id: appId }, { projection: { shardCount: 1, baselineDone: 1 } });
    if (!app) return;
    if (app.shardCount === n && app.baselineDone) {
      await diff(m, appId, ts, n, shards, snap.guilds, false, ts, now);
      return;
    }
    await m.c.snapshotPending.bulkWrite(
      shards.map((shard) => ({
        updateOne: {
          filter: { _id: { appId, shardCount: n, shard } },
          update: { $set: { guilds: snap.guilds, ts } },
          upsert: true,
        },
      })),
    );
    const reported = await m.c.snapshotPending
      .find({ '_id.appId': appId, '_id.shardCount': n, '_id.shard': { $lt: n } })
      .toArray();
    if (reported.length < n) return;
    // Each shard against its own snapshot: one taken minutes ago knows nothing of the joins and leaves since.
    for (const row of reported) {
      const own = row.guilds.filter((guild) => shardForGuild(guild, n) === row._id.shard);
      await diff(m, appId, ts, n, [row._id.shard], own, !app.baselineDone, row.ts, now);
    }
    await m.c.apps.updateOne({ _id: appId }, { $set: { shardCount: n, baselineDone: true } });
    await m.c.snapshotPending.deleteMany({ '_id.appId': appId });
  });
}

/**
 * Joins and removals the snapshot shows, for the given shards. A server whose join or leave was recorded after the
 * snapshot was taken (`takenAt`) is left alone: that event is newer than the snapshot's view of it. The entries this
 * snapshot records itself (at `ts`, detected at startup) are not newer: a retry finds them and applies what's pending.
 */
async function diff(
  m: Mongo,
  appId: string,
  ts: Date,
  shardCount: number,
  shards: number[],
  listed: string[],
  baseline: boolean,
  takenAt: Date,
  now: Date,
): Promise<void> {
  const present = [...new Set(listed)];
  const later = await m.c.guildEvents
    .find(
      {
        '_id.appId': appId,
        '_id.ts': { $gt: takenAt },
        '_id.kind': { $in: [GUILD_EVENT.join, GUILD_EVENT.leave] },
      },
      { projection: { _id: 1, detectedAtStartup: 1 } },
    )
    .toArray();
  const newer = new Set(
    later.filter((e) => !(e.detectedAtStartup && e._id.ts.getTime() === ts.getTime())).map((e) => e._id.guildId),
  );

  if (!baseline) {
    const gone = await m.c.guilds
      .aggregate<{ _id: GuildDoc['_id'] }>([
        { $match: { '_id.appId': appId, leftAt: null, '_id.guildId': { $nin: present } } },
        { $match: { $expr: { $in: [shardOf('$_id.guildId', shardCount), shards] } } },
        { $project: { _id: 1 } },
      ])
      .toArray();
    const leaves: Lifecycle[] = gone
      .filter((g) => !newer.has(g._id.guildId))
      .map((g) => ({ guild: g._id.guildId, ts, kind: GUILD_EVENT.leave, detected: true }));
    if (leaves.length > 0) {
      const { apply } = await recordHistory(m, appId, leaves);
      const applied = leaves.filter((_, i) => apply[i]);
      if (applied.length > 0) await m.c.guilds.bulkWrite(applied.map((e) => leave(appId, e.guild, ts, now)));
      await settle(m, appId, applied);
    }
  }

  if (present.length === 0) return;
  const known = await m.c.guilds
    .find(
      { _id: { $in: present.map((g) => guildKey(appId, g)) }, leftAt: { $exists: false } },
      { projection: { _id: 1 } },
    )
    .toArray();
  const skip = new Set([...known.map((g) => g._id.guildId), ...newer]);
  const added = present.filter((g) => !skip.has(g));
  if (added.length === 0) return;
  if (baseline) {
    // Existing installs: their profiles arrive shortly in guild_update events.
    await m.c.guilds.bulkWrite(
      added.map((guild) => ({
        updateOne: {
          filter: { _id: guildKey(appId, guild) },
          update: {
            $setOnInsert: {
              name: '',
              memberCount: 0,
              features: [],
              joinedAt: ts,
              baseline: true,
              detectedAtStartup: false,
              updatedAt: now,
            },
          },
          upsert: true,
        },
      })),
      { ordered: false },
    );
    return;
  }
  const joins: Lifecycle[] = added.map((guild) => ({ guild, ts, kind: GUILD_EVENT.join, detected: true }));
  const { apply } = await recordHistory(m, appId, joins);
  const applied = joins.filter((_, i) => apply[i]);
  if (applied.length > 0) {
    await m.c.guilds.bulkWrite(
      applied.map((e): AnyBulkWriteOperation<GuildDoc> => ({
        updateOne: {
          filter: { _id: guildKey(appId, e.guild) },
          update: {
            $set: { joinedAt: ts, detectedAtStartup: true, baseline: false },
            $unset: { leftAt: '', sizeAtJoin: '', firstCommandAt: '', lastCommandAt: '' },
            $setOnInsert: { name: '', memberCount: 0, features: [], updatedAt: now },
          },
          upsert: true,
        },
      })),
      { ordered: false },
    );
  }
  await settle(m, appId, applied);
}
