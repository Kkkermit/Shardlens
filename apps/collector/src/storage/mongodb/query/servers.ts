import { type Document, Long } from 'mongodb';
import type { Spec } from '../../../query/spec.js';
import type { QueryAnswer, QueryStorage } from '../../store.js';
import type { GuildDoc } from '../collections.js';
import type { Mongo } from '../connect.js';
import { guildProfiles } from './guild-profiles.js';
import { idPrefix } from './id-prefix.js';
import { rollupSource } from './read-window.js';
import { currentPeriodStart } from './salt-period-start.js';
import { dayText, wallClock } from './zoned-buckets.js';

const DAY = 86_400_000;
const WEEK = 7 * DAY;

type ServerRow = QueryAnswer<'servers'>['rows'][number];
type Growth = QueryAnswer<'growth'>;
type SizeBucket = Growth['sizeAtInstall'][number]['bucket'];
type LifetimeBucket = Growth['lifetimes'][number]['bucket'];

const SIZE_RANGE: Record<string, [number, number]> = {
  '1-10': [1, 10],
  '11-100': [11, 100],
  '101-1k': [101, 1_000],
  '1k-10k': [1_001, 10_000],
  '10k+': [10_001, 2_147_483_647],
};
/** Upper bounds of the size-at-join buckets, smallest first; anything larger is `10k+`. */
const SIZE_BUCKETS: [number, SizeBucket][] = [
  [10, '1-10'],
  [100, '11-100'],
  [1_000, '101-1k'],
  [10_000, '1k-10k'],
];
/** Lifetimes under each bound, shortest first; anything longer is `90d+`. */
const LIFETIME_BUCKETS: [number, LifetimeBucket][] = [
  [DAY, '<1d'],
  [7 * DAY, '1-7d'],
  [30 * DAY, '7-30d'],
  [90 * DAY, '30-90d'],
];
const EVENT_KIND = { 1: 'join', 2: 'leave', 3: 'unavailable' } as const;

const ROW_FIELDS = {
  name: 1,
  icon: 1,
  memberCount: 1,
  boosts: 1,
  premiumTier: 1,
  preferredLocale: 1,
  features: 1,
  joinedAt: 1,
  leftAt: 1,
  shard: 1,
  lastCommandAt: 1,
  detectedAtStartup: 1,
  baseline: 1,
} as const;
type RowFields = Pick<GuildDoc, '_id' | keyof typeof ROW_FIELDS>;

/** A server ID as the number PostgreSQL's `bigint` orders it by: `'9…'` (18 digits) comes before `'1…'` (19). */
const NUMERIC_ID = { $toLong: '$_id.guildId' };

const isMissing = (field: string) => ({ $eq: [{ $ifNull: [field, null] }, null] });

function serverRow(g: RowFields, runs: number): ServerRow {
  return {
    id: g._id.guildId,
    name: g.name,
    icon: g.icon ?? null,
    memberCount: g.memberCount,
    boosts: g.boosts ?? null,
    premiumTier: g.premiumTier ?? null,
    locale: g.preferredLocale ?? null,
    features: g.features,
    joinedAt: g.joinedAt,
    leftAt: g.leftAt ?? null,
    shard: g.shard ?? null,
    lastActive: g.lastCommandAt ?? null,
    detectedAtStartup: g.detectedAtStartup,
    baseline: g.baseline,
    runs,
  };
}

/** A setting's value as PostgreSQL's `value #>> '{}'` gives it: a JSON string unquoted, anything else as JSON. */
function settingText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * The servers a `servers` spec matches, or `null` when none can: missing permissions are judged against the required
 * ones in Settings, and with none set no server lacks any.
 */
async function serverFilter(m: Mongo, appId: string, spec: Spec<'servers'>, now: Date): Promise<Document | null> {
  const filter: Document = { '_id.appId': appId };
  if (spec.status === 'active') filter.leftAt = null;
  if (spec.status === 'left') filter.leftAt = { $ne: null };
  // PostgreSQL's ILIKE: the text anywhere in the name, any case.
  if (spec.search) filter.name = { $regex: spec.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
  if (spec.feature) filter.features = spec.feature;
  if (spec.locale) filter.preferredLocale = spec.locale;
  if (spec.size) {
    const [lo, hi] = SIZE_RANGE[spec.size]!;
    filter.memberCount = { $gte: lo, $lte: hi };
  }
  if (spec.inactive) {
    filter.$or = [{ lastCommandAt: null }, { lastCommandAt: { $lt: new Date(now.getTime() - 30 * DAY) } }];
  }
  if (spec.missingPermissions) {
    const setting = await m.c.settings.findOne({ _id: { appId, key: 'required_permissions' } });
    const bits = settingText(setting?.value);
    if (bits === undefined) return null;
    const need = Long.fromBigInt(BigInt(bits));
    // Bits that don't fit a signed 64-bit integer don't convert, and PostgreSQL leaves those servers out too.
    const have = { $convert: { input: '$botPermissions', to: 'long', onError: null, onNull: null } };
    filter.$expr = {
      $let: {
        vars: { have },
        in: {
          $and: [
            { $ne: ['$$have', null] },
            // Administrator (8) grants everything.
            { $eq: [{ $bitAnd: ['$$have', Long.fromNumber(8)] }, 0] },
            { $ne: [{ $bitAnd: ['$$have', need] }, need] },
          ],
        },
      },
    };
  }
  return filter;
}

/** Command runs per server in the last 30 days, from hourly rollups, for the servers listed. */
async function runsOf(m: Mongo, appId: string, guilds: readonly string[], since: Date): Promise<Map<string, number>> {
  if (guilds.length === 0) return new Map();
  const rows = await m.c.rollup1h
    .aggregate<{ _id: string; runs: number }>([
      { $match: { appId, metric: 'interactions.by_guild', bucket: { $gte: since }, 'dims.guild': { $in: guilds } } },
      { $group: { _id: '$dims.guild', runs: { $sum: '$count' } } },
    ])
    .toArray();
  return new Map(rows.map((r) => [r._id, r.runs]));
}

/** PostgreSQL's `lower()` on a UTF-8 database: each character on its own (`Σ` is `σ` even at the end of a word). */
function pgLower(text: string): string {
  let out = '';
  for (const ch of text) out += ch === 'İ' ? 'i' : ch.toLowerCase();
  return out;
}

async function servers(m: Mongo, appId: string, spec: Spec<'servers'>, now: Date): Promise<QueryAnswer<'servers'>> {
  const filter = await serverFilter(m, appId, spec, now);
  if (!filter) return { total: 0, rows: [] };
  const since = new Date(now.getTime() - 30 * DAY);
  const dir = spec.order === 'asc' ? 1 : -1;
  const page = [{ $skip: spec.offset }, { $limit: spec.limit }];

  if (spec.sort === 'runs') {
    // Every matching server needs its runs to be ordered by them: the rollups' runs per server and the servers meet
    // in one group, rather than a lookup per server.
    const doc = Object.fromEntries(Object.keys({ _id: 1, ...ROW_FIELDS }).map((k) => [k, `$${k}`]));
    const [result] = await m.c.guilds
      .aggregate<{ total: { n: number }[]; rows: { doc: RowFields; runs: number }[] }>([
        { $match: filter },
        { $project: { _id: 0, g: '$_id.guildId', doc, runs: { $literal: 0 } } },
        {
          $unionWith: {
            coll: m.c.rollup1h.collectionName,
            pipeline: [
              { $match: { appId, metric: 'interactions.by_guild', bucket: { $gte: since } } },
              { $group: { _id: '$dims.guild', runs: { $sum: '$count' } } },
              { $project: { _id: 0, g: '$_id', runs: 1 } },
            ],
          },
        },
        { $group: { _id: '$g', doc: { $max: '$doc' }, runs: { $sum: '$runs' } } },
        { $match: { doc: { $ne: null } } },
        {
          $facet: {
            total: [{ $count: 'n' }],
            rows: [{ $set: { idn: { $toLong: '$_id' } } }, { $sort: { runs: dir, idn: 1 } }, ...page],
          },
        },
      ])
      .toArray();
    return { total: result?.total[0]?.n ?? 0, rows: (result?.rows ?? []).map((r) => serverRow(r.doc, r.runs)) };
  }

  if (spec.sort === 'name') {
    // By the lowercased name's bytes, as PostgreSQL orders text under the C collation and musl's (its Alpine images):
    // MongoDB's `$toLower` lowercases ASCII only, so the order is worked out here from the names alone.
    const names = await m.c.guilds.find(filter, { projection: { name: 1 } }).toArray();
    const keyed = names.map((g) => ({
      id: g._id.guildId,
      n: BigInt(g._id.guildId),
      key: Buffer.from(pgLower(g.name)),
    }));
    keyed.sort((a, b) => dir * Buffer.compare(a.key, b.key) || (a.n < b.n ? -1 : a.n > b.n ? 1 : 0));
    const ids = keyed.slice(spec.offset, spec.offset + spec.limit).map((k) => k.id);
    const [docs, runs] = await Promise.all([
      m.c.guilds
        .find({ _id: { $in: ids.map((guildId) => ({ appId, guildId })) } }, { projection: ROW_FIELDS })
        .toArray(),
      runsOf(m, appId, ids, since),
    ]);
    const byId = new Map(docs.map((d) => [d._id.guildId, d]));
    const rows = ids.flatMap((id) => byId.get(id) ?? []);
    return { total: names.length, rows: rows.map((r) => serverRow(r, runs.get(r._id.guildId) ?? 0)) };
  }

  const key = { members: '$memberCount', joined: '$joinedAt', last_active: '$lastCommandAt' }[spec.sort];
  const [result] = await m.c.guilds
    .aggregate<{ total: { n: number }[]; rows: RowFields[] }>([
      { $match: filter },
      {
        $facet: {
          total: [{ $count: 'n' }],
          rows: [
            { $set: { unset: { $cond: [isMissing(key), 1, 0] }, key, idn: NUMERIC_ID } },
            // NULLS LAST in either direction, then the server ID.
            { $sort: { unset: 1, key: dir, idn: 1 } },
            ...page,
            { $project: ROW_FIELDS },
          ],
        },
      },
    ])
    .toArray();
  const rows = result?.rows ?? [];
  const runs = await runsOf(
    m,
    appId,
    rows.map((r) => r._id.guildId),
    since,
  );
  return { total: result?.total[0]?.n ?? 0, rows: rows.map((r) => serverRow(r, runs.get(r._id.guildId) ?? 0)) };
}

async function server(m: Mongo, appId: string, spec: Spec<'server'>, now: Date): Promise<QueryAnswer<'server'>> {
  const guildId = spec.guild;
  const [periodStart, g, history, required] = await Promise.all([
    currentPeriodStart(m, appId, now),
    m.c.guilds.findOne({ _id: { appId, guildId } }),
    // The server's history is a range of `_id` (app, server, time, kind), read newest first from the `_id` index.
    m.c.guildEvents.find(idPrefix({ appId, guildId }, 'ts')).sort({ _id: -1 }).limit(100).toArray(),
    m.c.settings.findOne({ _id: { appId, key: 'required_permissions' } }),
  ]);
  if (!g) return { found: false };
  const users = await m.c.uniqueCounts.findOne(
    { _id: { appId, grain: 'month', startDay: periodStart, scope: 'guild', scopeKey: guildId } },
    { projection: { users: 1 } },
  );
  const requiredBits = settingText(required?.value);
  let missingPermissions: string | null = null;
  if (requiredBits && g.botPermissions) {
    const have = BigInt(g.botPermissions);
    const need = BigInt(requiredBits);
    missingPermissions = (have & 8n) === 8n ? '0' : (need & ~have).toString();
  }
  return {
    found: true,
    profile: {
      id: g._id.guildId,
      name: g.name,
      icon: g.icon ?? null,
      memberCount: g.memberCount,
      sizeAtJoin: g.sizeAtJoin ?? null,
      large: g.large ?? null,
      locale: g.preferredLocale ?? null,
      features: g.features,
      premiumTier: g.premiumTier ?? null,
      boosts: g.boosts ?? null,
      verificationLevel: g.verificationLevel ?? null,
      nsfwLevel: g.nsfwLevel ?? null,
      mfaLevel: g.mfaLevel ?? null,
      createdAt: g.createdAt ?? null,
      joinedAt: g.joinedAt,
      leftAt: g.leftAt ?? null,
      shard: g.shard ?? null,
      channelCounts: g.channelCounts ?? null,
      roleCount: g.roleCount ?? null,
      emojiCount: g.emojiCount ?? null,
      stickerCount: g.stickerCount ?? null,
      botPermissions: g.botPermissions ?? null,
      detectedAtStartup: g.detectedAtStartup,
      baseline: g.baseline,
      firstCommandAt: g.firstCommandAt ?? null,
      lastCommandAt: g.lastCommandAt ?? null,
      updatedAt: g.updatedAt,
    },
    events: history.map((e) => ({
      ts: e._id.ts,
      kind: EVENT_KIND[e._id.kind as keyof typeof EVENT_KIND] ?? 'available',
      detectedAtStartup: e.detectedAtStartup,
    })),
    uniqueUsersThisPeriod: users?.users ?? null,
    periodStart,
    missingPermissions,
  };
}

/** Monday 00:00 UTC of the week `ms` falls in: PostgreSQL's `date_trunc('week', …)` in the collector's UTC session. */
function weekStart(ms: number): number {
  const day = Math.floor(ms / DAY) * DAY;
  return day - ((new Date(day).getUTCDay() + 6) % 7) * DAY;
}

const weekOf = (date: unknown) => ({ $dateTrunc: { date, unit: 'week', startOfWeek: 'monday' } });

async function growth(m: Mongo, appId: string, spec: Spec<'growth'>, now: Date): Promise<Growth> {
  const from = new Date(spec.range.from);
  const to = new Date(spec.range.to);
  const source = rollupSource(m, from, now);
  const inRange = { $gte: from, $lt: to };
  const joins = { $eq: ['$metric', 'guild.joins'] };
  const leaves = { $eq: ['$metric', 'guild.leaves'] };
  const detected = { $eq: ['$dims.detected', true] };
  // A figure over no rollups at all is `null`, as `sum() FILTER (...)` is: the rows matched are counted beside it.
  const sumIf = (cond: unknown) => ({ $sum: { $cond: [cond, '$count', 0] } });
  const countIf = (cond: unknown) => ({ $sum: { $cond: [cond, 1, 0] } });
  const sizeBucket = SIZE_BUCKETS.reduceRight<unknown>(
    (larger, [max, bucket]) => ({ $cond: [{ $lte: ['$sizeAtJoin', max] }, bucket, larger] }),
    '10k+',
  );
  const lifetimeBucket = LIFETIME_BUCKETS.reduceRight<unknown>(
    (longer, [max, bucket]) => ({ $cond: [{ $lt: ['$lived', max] }, bucket, longer] }),
    '90d+',
  );
  const [daily, [facts], cohorts, approx, info] = await Promise.all([
    source.rollups
      .aggregate<{
        _id: string;
        joins: number;
        leaves: number;
        joinsDetected: number;
        leavesDetected: number;
        rows: [number, number, number, number];
      }>([
        { $match: { appId, metric: { $in: ['guild.joins', 'guild.leaves'] }, bucket: { $gte: source.from, $lt: to } } },
        {
          $group: {
            _id: dayText(wallClock('$bucket', spec.timezone)),
            joins: sumIf(joins),
            leaves: sumIf(leaves),
            joinsDetected: sumIf({ $and: [joins, detected] }),
            leavesDetected: sumIf({ $and: [leaves, detected] }),
            j: countIf(joins),
            l: countIf(leaves),
            jd: countIf({ $and: [joins, detected] }),
            ld: countIf({ $and: [leaves, detected] }),
          },
        },
        { $set: { rows: ['$j', '$l', '$jd', '$ld'] } },
        { $sort: { _id: 1 } },
      ])
      .toArray(),
    m.c.guilds
      .aggregate<{
        sizes: { _id: SizeBucket; servers: number }[];
        activation: { joined: number; activated: number }[];
        lifetimes: { _id: LifetimeBucket; servers: number }[];
        installs: { active: number; inactive: number }[];
      }>([
        { $match: { '_id.appId': appId } },
        {
          $facet: {
            sizes: [
              { $match: { joinedAt: inRange, baseline: { $ne: true }, sizeAtJoin: { $ne: null } } },
              { $group: { _id: sizeBucket, servers: { $sum: 1 } } },
            ],
            activation: [
              { $match: { joinedAt: inRange, baseline: { $ne: true }, detectedAtStartup: { $ne: true } } },
              {
                $group: {
                  _id: null,
                  joined: { $sum: 1 },
                  activated: countIf({
                    $and: [
                      { $not: [isMissing('$firstCommandAt')] },
                      { $lt: ['$firstCommandAt', { $add: ['$joinedAt', DAY] }] },
                    ],
                  }),
                },
              },
            ],
            lifetimes: [
              { $match: { leftAt: inRange, baseline: { $ne: true } } },
              { $set: { lived: { $subtract: ['$leftAt', '$joinedAt'] } } },
              { $group: { _id: lifetimeBucket, servers: { $sum: 1 } } },
            ],
            installs: [
              { $match: { leftAt: null } },
              {
                $group: {
                  _id: null,
                  active: { $sum: 1 },
                  inactive: countIf({
                    $or: [isMissing('$lastCommandAt'), { $lt: ['$lastCommandAt', new Date(now.getTime() - 30 * DAY)] }],
                  }),
                },
              },
            ],
          },
        },
      ])
      .toArray(),
    // Servers that joined in the range, by the week they joined, and the weeks since then that they ran a command in.
    // Grouped by server first, so each server's join week is looked up once.
    m.c.rollup1d
      .aggregate<{ _id: { cohort: Date; week: number }; servers: number }>([
        { $match: { appId, metric: 'interactions.by_guild', bucket: { $gte: new Date(weekStart(from.getTime())) } } },
        { $group: { _id: '$dims.guild', weeks: { $addToSet: weekOf('$bucket') } } },
        { $set: { guild: { appId: { $literal: appId }, guildId: '$_id' } } },
        {
          $lookup: {
            from: m.c.guilds.collectionName,
            localField: 'guild',
            foreignField: '_id',
            as: 'guild',
            pipeline: [{ $project: { joinedAt: 1, baseline: 1 } }],
          },
        },
        { $unwind: '$guild' },
        { $match: { 'guild.joinedAt': inRange, 'guild.baseline': { $ne: true } } },
        { $set: { cohort: weekOf('$guild.joinedAt') } },
        { $unwind: '$weeks' },
        { $match: { $expr: { $gte: ['$weeks', '$cohort'] } } },
        {
          $group: {
            _id: { cohort: '$cohort', week: { $divide: [{ $subtract: ['$weeks', '$cohort'] }, WEEK] } },
            servers: { $sum: 1 },
          },
        },
        { $sort: { '_id.cohort': 1, '_id.week': 1 } },
      ])
      .toArray(),
    m.c.gauges
      .aggregate<{ _id: string; value: number }>([
        { $match: { '_id.appId': appId, '_id.name': 'app.approx_guilds', '_id.ts': inRange } },
        { $group: { _id: dayText('$_id.ts'), value: { $max: '$value' } } },
        { $sort: { _id: 1 } },
      ])
      .toArray(),
    m.c.appInfo.findOne({ _id: appId }, { projection: { ts: 1, approxGuilds: 1 } }),
  ]);
  const act = facts?.activation[0] ?? { joined: 0, activated: 0 };
  const installs = facts?.installs[0] ?? { active: 0, inactive: 0 };
  const sizes = new Map((facts?.sizes ?? []).map((s) => [s._id, s.servers]));
  const lifetimes = new Map((facts?.lifetimes ?? []).map((s) => [s._id, s.servers]));
  const ours = installs.active;
  const discord = info?.approxGuilds ?? null;
  const drift = discord ? (ours - discord) / discord : null;
  const orNull = (value: number, rows: number) => (rows > 0 ? value : null);
  return {
    daily: daily.map((d) => ({
      day: d._id,
      joins: orNull(d.joins, d.rows[0]),
      leaves: orNull(d.leaves, d.rows[1]),
      joinsDetected: orNull(d.joinsDetected, d.rows[2]),
      leavesDetected: orNull(d.leavesDetected, d.rows[3]),
    })),
    sizeAtInstall: [...SIZE_BUCKETS.map(([, b]) => b), '10k+' as const].flatMap((bucket) => {
      const servers = sizes.get(bucket);
      return servers === undefined ? [] : [{ bucket, servers }];
    }),
    activation: {
      joined: act.joined,
      activated: act.activated,
      rate: act.joined > 0 ? act.activated / act.joined : null,
    },
    installs: { active: installs.active, inactive: installs.inactive },
    cohorts: cohorts.map((c) => ({
      cohort: c._id.cohort.toISOString().slice(0, 10),
      week: c._id.week,
      servers: c.servers,
    })),
    lifetimes: [...LIFETIME_BUCKETS.map(([, b]) => b), '90d+' as const].flatMap((bucket) => {
      const servers = lifetimes.get(bucket);
      return servers === undefined ? [] : [{ bucket, servers }];
    }),
    approximateGuilds: approx.map((a) => ({ day: a._id, value: a.value })),
    serverCount: {
      ours,
      discord,
      at: info?.ts ?? null,
      drift,
      warn: drift !== null && Math.abs(drift) > 0.02,
    },
  };
}

export function mongoServersQueries(m: Mongo): Pick<QueryStorage, 'servers' | 'server' | 'growth' | 'guildNames'> {
  return {
    servers: (appId, spec, now) => servers(m, appId, spec, now),
    server: (appId, spec, now) => server(m, appId, spec, now),
    growth: (appId, spec, now) => growth(m, appId, spec, now),
    guildNames: (appId, ids) => guildProfiles(m, appId, ids),
  };
}
