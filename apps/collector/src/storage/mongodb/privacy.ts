import { Binary, type Filter, ObjectId, UUID } from 'mongodb';
import { OUTCOME } from '../../ingest/codes.js';
import type { PrivacyStorage } from '../store.js';
import type { AuditLogDoc } from './collections.js';
import type { Mongo } from './connect.js';
import { asJson } from './json.js';

const DAY = 86_400_000;

/**
 * A filter value PostgreSQL refuses to cast (`$1::timestamptz`, `$1::uuid`). It answers those 400 through
 * `Store.refusedInput`; this error carries the same answer for the HTTP layer.
 */
function refused(what: string): Error {
  return Object.assign(new Error(`MongoStore: ${what}`), { statusCode: 400, code: 'invalid_request' });
}

const ISO_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(?:Z|([+-])(\d{2})(?::?(\d{2}))?)?$/i;

/** Round half to even, as C's `rint`. */
function rint(x: number): number {
  const r = Math.round(x);
  return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/**
 * An ISO 8601 time as PostgreSQL reads it into a `timestamptz`, which keeps microseconds: the millisecond it falls in,
 * and whether it is that millisecond exactly. Stored times are whole milliseconds, so a time between two of them
 * compares as the next one up. No offset means UTC, the collector's session time zone.
 */
function parseTime(text: string): { ms: number; exact: boolean } {
  const m = ISO_TIME.exec(text);
  if (!m) throw refused(`${text} is not a time`);
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map((v) => Number(v ?? 0)) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const frac = m[7] ?? '';
  const offset = m[8] ? (m[8] === '-' ? -1 : 1) * (Number(m[9]) * 60 + Number(m[10] ?? 0)) : 0;
  // As PostgreSQL's `ParseFractionalSecond`: the fraction read as a double, rounded to microseconds.
  const micros = frac ? rint(Number(`0.${frac}`) * 1e6) : 0;
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1] ?? 0;
  const valid =
    y >= 1 &&
    d >= 1 &&
    d <= daysInMonth &&
    (h < 24 || (h === 24 && mi === 0 && s === 0 && micros === 0)) &&
    mi <= 59 &&
    s <= 60 &&
    Number(m[9] ?? 0) <= 15 &&
    Number(m[10] ?? 0) <= 59;
  if (!valid) throw refused(`${text} is not a time`);
  const wall = new Date(0);
  wall.setUTCFullYear(y, mo - 1, d);
  wall.setUTCHours(h, mi, s);
  const totalMicros = (wall.getTime() - offset * 60_000) * 1000 + micros;
  return { ms: Math.floor(totalMicros / 1000), exact: totalMicros % 1000 === 0 };
}

/** The first stored millisecond at or after `time`: `ts >= time` and `ts < time` are `ts >= it` and `ts < it`. */
function ceilMs(time: { ms: number; exact: boolean }): Date {
  return new Date(time.exact ? time.ms : time.ms + 1);
}

/** A UUID as PostgreSQL's `uuid` input reads it: 32 hex digits, a hyphen allowed after any group of four. */
function parseUuid(text: string): UUID {
  if (!/^[0-9a-f]{4}(?:-?[0-9a-f]{4}){7}$/i.test(text)) throw refused(`${text} is not a UUID`);
  return new UUID(text.replaceAll('-', '').toLowerCase());
}

const bytes = (b: Binary) => Buffer.from(b.buffer);

export function mongoPrivacy({ c }: Mongo): PrivacyStorage {
  return {
    async logAccess(entry) {
      await c.accessLog.insertOne({
        _id: new ObjectId(),
        ts: new Date(),
        appId: entry.appId,
        viewerUserId: entry.viewerUserId,
        ...(entry.viewerKeyId !== null && { viewerKeyId: entry.viewerKeyId }),
        action: entry.action,
        details: asJson(entry.details),
      });
    },

    async accessLog(appId) {
      const rows = await c.accessLog.find({ appId }).sort({ ts: -1, _id: -1 }).limit(200).toArray();
      const keyIds = [...new Set(rows.flatMap((r) => (r.viewerKeyId === undefined ? [] : [r.viewerKeyId])))];
      const keys =
        keyIds.length === 0
          ? []
          : await c.apiKeys.find({ _id: { $in: keyIds } }, { projection: { label: 1 } }).toArray();
      const labels = new Map(keys.map((k) => [k._id, k.label ?? null]));
      return rows.map((r) => ({
        ts: r.ts,
        viewerUserId: r.viewerUserId,
        viewerKey: r.viewerKeyId === undefined ? null : (labels.get(r.viewerKeyId) ?? null),
        action: r.action,
        details: r.details,
      }));
    },

    async eraseHashes(appId, hashes) {
      // Every collection that holds a salted user hash, as PostgreSQL's `HASHED_TABLES`.
      const $in = hashes.map((h) => new Binary(h));
      const deleted = await Promise.all([
        c.interactions.deleteMany({ appId, userHash: { $in } }),
        c.customEvents.deleteMany({ appId, userHash: { $in } }),
        c.uniques.deleteMany({ '_id.appId': appId, '_id.userHash': { $in } }),
        c.entitlements.deleteMany({ appId, userHash: { $in } }),
        c.subscriptions.deleteMany({ appId, userHash: { $in } }),
        c.webhookEvents.deleteMany({ appId, userHash: { $in } }),
      ]);
      return deleted.reduce((n, r) => n + r.deletedCount, 0);
    },

    async eraseActivity(appId, actorLookup) {
      const res = await c.auditLog.deleteMany({ appId, actorLookup: new Binary(actorLookup) });
      return res.deletedCount;
    },

    async installers(appId) {
      const rows = await c.webhookEvents
        .find({ appId, actorEnc: { $exists: true } }, { projection: { ts: 1, actorEnc: 1 } })
        .toArray();
      return rows.flatMap((w) => (w.actorEnc ? [{ id: w._id.toHexString(), ts: w.ts, actor: bytes(w.actorEnc) }] : []));
    },

    async forgetInstaller(id) {
      // The event ID alone finds the delivery; PostgreSQL also takes its time, to find the partition.
      await c.webhookEvents.updateOne({ _id: new UUID(id) }, { $unset: { actorEnc: '' } });
    },

    async activity(appId, f, limit) {
      const filter: Filter<AuditLogDoc> = { appId };
      const ts: { $gte?: Date; $lte?: Date; $lt?: Date } = {};
      if (f.from) ts.$gte = ceilMs(parseTime(f.from));
      let lt = f.to ? ceilMs(parseTime(f.to)) : undefined;
      if (f.before) {
        const before = parseTime(f.before.ts);
        const id = f.before.id === undefined ? undefined : parseUuid(f.before.id);
        if (id && before.exact) {
          // (ts, id) < (before, id): rows of that very millisecond count only with a lower ID.
          ts.$lte = new Date(before.ms);
          filter.$nor = [{ ts: new Date(before.ms), _id: { $gte: id } }];
        } else {
          const end = ceilMs(before);
          if (!lt || end < lt) lt = end;
        }
      }
      if (lt) ts.$lt = lt;
      if (Object.keys(ts).length > 0) filter.ts = ts;
      if (f.command) filter.command = f.command;
      if (f.guild) filter.guildId = f.guild;
      if (f.actorLookup) filter.actorLookup = new Binary(f.actorLookup);
      // `$gt: 0` for every failed outcome: the condition of the indexes that hold only failures.
      if (f.outcome === 'failed') filter.outcome = { $gt: 0 };
      else if (f.outcome === 'ok') filter.outcome = OUTCOME.ok;
      else if (f.outcome) filter.outcome = { $gt: 0, $eq: OUTCOME[f.outcome] };

      const rows = await c.auditLog.find(filter).sort({ ts: -1, _id: -1 }).limit(limit).toArray();
      const guildIds = [...new Set(rows.flatMap((r) => (r.guildId === undefined ? [] : [r.guildId])))];
      const guilds =
        guildIds.length === 0
          ? []
          : await c.guilds
              .find({ _id: { $in: guildIds.map((guildId) => ({ appId, guildId })) } }, { projection: { name: 1 } })
              .toArray();
      const names = new Map(guilds.map((g) => [g._id.guildId, g.name ?? '']));
      return rows.map((r) => ({
        interactionId: r._id.toHexString(),
        ts: r.ts,
        guildId: r.guildId ?? null,
        guildName: r.guildId === undefined ? null : (names.get(r.guildId) ?? null),
        kind: r.kind,
        command: r.command ?? null,
        sub: r.sub ?? null,
        customId: r.customId ?? null,
        outcome: r.outcome,
        ackMs: r.ackMs ?? null,
        userId: bytes(r.actorEnc),
        profile: r.namesEnc ? bytes(r.namesEnc) : null,
      }));
    },

    async topActors(appId, window) {
      const since = new Date(Date.now() - (window === '24h' ? 1 : 7) * DAY);
      const rows = await c.auditLog
        .aggregate<{ actorEnc: Binary; runs: number }>([
          { $match: { appId, ts: { $gte: since } } },
          {
            $group: {
              _id: '$actorLookup',
              actorEnc: { $top: { sortBy: { ts: -1 }, output: '$actorEnc' } },
              runs: { $sum: 1 },
            },
          },
          { $sort: { runs: -1, _id: 1 } },
          { $limit: 25 },
        ])
        .toArray();
      return rows.map((r) => ({ userId: bytes(r.actorEnc), runs: r.runs }));
    },
  };
}
