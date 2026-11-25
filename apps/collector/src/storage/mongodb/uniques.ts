import { type AnyBulkWriteOperation, type Binary, type Document, MaxKey, MinKey } from 'mongodb';
import { periodBounds } from '../periods.js';
import type { UniqueCountDoc, UniqueDoc } from './collections.js';
import type { Mongo } from './connect.js';
import { isDuplicateKey } from './duplicate-key.js';

const DAY = 86_400_000;

/** A unique-user document's `_id`, its fields always in this order: `_id` equality and ranges compare in order. */
export function uniqueId(
  appId: string,
  period: string,
  scope: string,
  scopeKey: string,
  day: string,
  userHash: Binary,
): UniqueDoc['_id'] {
  return { appId, period, scope, scopeKey, day, userHash };
}

/**
 * An app's unique-user documents of one salt period, as a range of `_id` ({@link uniqueId} order), so the `_id` index
 * finds them without an index of their own on a collection this large. A plain document: the driver's filter types
 * have no way to say a range of partial compound IDs.
 */
export function uniquesOfPeriod(appId: string, period: string): Document {
  return { _id: { $gte: { appId, period, scope: new MinKey() }, $lt: { appId, period, scope: new MaxKey() } } };
}

const countId = (
  appId: string,
  grain: UniqueCountDoc['_id']['grain'],
  startDay: string,
  scope: string,
  scopeKey: string,
): UniqueCountDoc['_id'] => ({ appId, grain, startDay, scope, scopeKey });

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Unique-user counts for every salt whose secret is still there (or one app, or one period): per day with new users
 * (first day seen in the period), per ISO week wholly inside the period, and for the whole period. A count marked
 * final is never written again: the write's filter then matches nothing, and the insert it falls back to is refused as
 * a duplicate, which is ignored.
 *
 * A week that spans two periods gets no count: the same person has a different hash in each, so the users of the two
 * parts can't be told apart.
 */
export async function runUniques(m: Mongo, appId?: string, onlyPeriod?: string, final = false): Promise<void> {
  const { c } = m;
  const salts = await c.salts
    .find(
      {
        secret: { $exists: true },
        ...(appId === undefined ? {} : { '_id.appId': appId }),
        ...(onlyPeriod === undefined ? {} : { '_id.period': onlyPeriod }),
      },
      { projection: { _id: 1 } },
    )
    .toArray();
  for (const { _id: salt } of salts) {
    const bounds = periodBounds(salt.period);
    if (!bounds) continue;
    const of = uniquesOfPeriod(salt.appId, salt.period);
    const [days, weeks, whole] = await Promise.all([
      c.uniques
        .aggregate<{ _id: { s: string; k: string; d: string }; users: number; newUsers: number }>([
          { $match: { ...of, '_id.scope': { $in: ['global', 'command'] } } },
          {
            $group: {
              _id: { s: '$_id.scope', k: '$_id.scopeKey', h: '$_id.userHash' },
              first: { $min: '$_id.day' },
              days: { $push: '$_id.day' },
            },
          },
          { $unwind: '$days' },
          {
            $group: {
              _id: { s: '$_id.s', k: '$_id.k', d: '$days' },
              users: { $sum: 1 },
              newUsers: { $sum: { $cond: [{ $eq: ['$days', '$first'] }, 1, 0] } },
            },
          },
        ])
        .toArray(),
      c.uniques
        .aggregate<{ _id: { k: string; w: Date }; users: number }>([
          { $match: { ...of, '_id.scope': 'global' } },
          {
            $project: {
              k: '$_id.scopeKey',
              h: '$_id.userHash',
              w: {
                $dateTrunc: {
                  date: { $dateFromString: { dateString: '$_id.day', format: '%Y-%m-%d' } },
                  unit: 'week',
                  startOfWeek: 'monday',
                },
              },
            },
          },
          { $match: { w: { $gte: new Date(bounds.start), $lte: new Date(bounds.end - 7 * DAY) } } },
          { $group: { _id: { k: '$k', w: '$w', h: '$h' } } },
          { $group: { _id: { k: '$_id.k', w: '$_id.w' }, users: { $sum: 1 } } },
        ])
        .toArray(),
      c.uniques
        .aggregate<{ _id: { s: string; k: string }; users: number }>([
          { $match: of },
          { $group: { _id: { s: '$_id.scope', k: '$_id.scopeKey', h: '$_id.userHash' } } },
          { $group: { _id: { s: '$_id.s', k: '$_id.k' }, users: { $sum: 1 } } },
        ])
        .toArray(),
    ]);
    const write = (
      id: UniqueCountDoc['_id'],
      users: number,
      newUsers?: number,
    ): AnyBulkWriteOperation<UniqueCountDoc> => ({
      updateOne: {
        filter: { _id: id, final: { $ne: true } },
        update:
          newUsers === undefined
            ? { $set: { users, final }, $setOnInsert: { newUsers: 0 } }
            : { $set: { users, newUsers, final } },
        upsert: true,
      },
    });
    const start = isoDay(bounds.start);
    const ops = [
      ...days.map((r) => write(countId(salt.appId, 'day', r._id.d, r._id.s, r._id.k), r.users, r.newUsers)),
      ...weeks.map((r) => write(countId(salt.appId, 'week', isoDay(r._id.w.getTime()), 'global', r._id.k), r.users)),
      ...whole.map((r) => write(countId(salt.appId, 'month', start, r._id.s, r._id.k), r.users)),
    ];
    if (ops.length === 0) continue;
    try {
      await c.uniqueCounts.bulkWrite(ops, { ordered: false });
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
    }
  }
}
