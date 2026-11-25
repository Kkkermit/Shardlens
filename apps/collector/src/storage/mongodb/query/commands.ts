import { BUCKETS, bucketOf } from '@shardlens/core';
import { KIND } from '../../../ingest/codes.js';
import { decodeValue } from '../../../query/dimensions.js';
import { withGuildNames } from '../../../query/guild-names.js';
import type { Spec } from '../../../query/spec.js';
import type { QueryAnswer, QueryStorage } from '../../store.js';
import type { Mongo } from '../connect.js';
import { ackQuantile } from '../histogram.js';
import { guildProfiles } from './guild-profiles.js';
import { idPrefix } from './id-prefix.js';
import { byteOrder, jsonText, real, realOrNull, realShare, roundTenths } from './pg-values.js';
import { rawFrom, rollupSource } from './read-window.js';
import { dim, HIST_ARRAY, HIST_SUMS, histQuantile } from './rollup-reads.js';
import { currentPeriodStart } from './salt-period-start.js';

/*
 * The command list (from rollups) and one command's page (from single events), as `postgres/query/pages.ts` answers
 * them. Each answer section PostgreSQL reads with its own statement is a `$facet` of one aggregation here.
 */

const COMMAND_KINDS = [
  KIND.chat_input,
  KIND.user_context,
  KIND.message_context,
  KIND.primary_entry_point,
  KIND.message_command,
];

interface CommandFigures {
  _id: string | null;
  runs: number;
  failures: number;
  p95: number | null;
  lastUsed: Date;
  kinds: number[];
}

async function commands(m: Mongo, appId: string, spec: Spec<'commands'>, now: Date): Promise<QueryAnswer<'commands'>> {
  const { rollups, from } = rollupSource(m, new Date(spec.range.from), now);
  const to = new Date(spec.range.to);
  const before = new Date(from.getTime() - (to.getTime() - from.getTime()));
  const [periodStart, [figures], registry] = await Promise.all([
    currentPeriodStart(m, appId, now),
    rollups
      .aggregate<{
        cur: CommandFigures[];
        srv: { _id: string | null; servers: number }[];
        prev: { _id: string | null; runs: number }[];
      }>([
        {
          $match: {
            appId,
            $or: [
              { metric: 'interactions', bucket: { $gte: before, $lt: to } },
              { metric: 'interactions.by_guild', bucket: { $gte: from, $lt: to } },
            ],
          },
        },
        {
          $facet: {
            cur: [
              { $match: { metric: 'interactions', bucket: { $gte: from } } },
              {
                $group: {
                  _id: dim('command'),
                  runs: { $sum: '$count' },
                  failures: {
                    $sum: {
                      $cond: [{ $and: [{ $ne: [dim('outcome'), null] }, { $ne: [dim('outcome'), '0'] }] }, '$count', 0],
                    },
                  },
                  ...HIST_SUMS,
                  lastUsed: { $max: '$bucket' },
                  kinds: { $addToSet: '$dims.kind' },
                },
              },
              {
                $project: {
                  runs: 1,
                  failures: 1,
                  lastUsed: 1,
                  kinds: 1,
                  p95: histQuantile([...HIST_ARRAY], 0.95),
                },
              },
            ],
            srv: [
              { $match: { metric: 'interactions.by_guild' } },
              { $group: { _id: { c: dim('command'), g: dim('guild') } } },
              {
                $group: {
                  _id: '$_id.c',
                  servers: { $sum: { $cond: [{ $eq: ['$_id.g', null] }, 0, 1] } },
                },
              },
            ],
            prev: [
              { $match: { metric: 'interactions', bucket: { $lt: from } } },
              { $group: { _id: dim('command'), runs: { $sum: '$count' } } },
            ],
          },
        },
      ])
      .toArray(),
    m.c.commandRegistry.find(idPrefix({ appId }, 'commandId'), { projection: { name: 1, type: 1 } }).toArray(),
  ]);
  const users = await m.c.uniqueCounts
    .find(idPrefix({ appId, grain: 'month', startDay: periodStart, scope: 'command' }, 'scopeKey'), {
      projection: { users: 1 },
    })
    .toArray();

  // A command with no name in the rollups is left out, as PostgreSQL's `coalesce(cur.command, reg.command) IS NOT NULL`.
  const cur = new Map<string, CommandFigures>();
  for (const row of figures?.cur ?? []) if (row._id !== null) cur.set(row._id, row);
  const servers = new Map((figures?.srv ?? []).map((r) => [r._id, r.servers]));
  const previous = new Map((figures?.prev ?? []).map((r) => [r._id, r.runs]));
  const registered = new Map<string, Set<number>>();
  for (const r of registry) registered.set(r.name, (registered.get(r.name) ?? new Set()).add(r.type));
  const unique = new Map(users.map((u) => [u._id.scopeKey, u.users]));

  const rows = [...new Set([...cur.keys(), ...registered.keys()])].map((command) => {
    const c = cur.get(command);
    const runs = c?.runs ?? 0;
    const previousRuns = previous.get(command) ?? 0;
    const reg = registered.get(command);
    return {
      command,
      runs,
      previousRuns,
      changePct: previousRuns === 0 ? null : roundTenths((100 * (runs - previousRuns)) / previousRuns),
      errorRate: runs === 0 ? null : (c?.failures ?? 0) / runs,
      p95Ms: c?.p95 ?? null,
      servers: servers.get(command) ?? 0,
      lastUsed: c?.lastUsed ?? null,
      uniqueUsersThisPeriod: unique.get(command) ?? null,
      registered: reg !== undefined,
      kinds: [...new Set([...(c?.kinds ?? []), ...(reg ?? [])])]
        .sort((a, b) => a - b)
        .map((k) => decodeValue('kind', String(k))),
    };
  });
  rows.sort((a, b) => b.runs - a.runs || byteOrder(a.command, b.command));
  return { periodStart, rows: rows.slice(0, 500) };
}

/** A breakdown row before decoding: the stored value and its runs. */
interface Split<K = unknown> {
  _id: K;
  value: number;
}

interface CommandFacets {
  totals: {
    n: number;
    runs: number;
    ok: number;
    error: number;
    timeout: number;
    noResponse: number;
    deferred: number;
    ephemeral: number;
    premium: number;
    interactions: number;
    over3s: number;
    answered: number;
    firstSeen: Date;
    lastSeen: Date;
  }[];
  ack: { _id: number; w: number }[];
  handler: { _id: number; w: number }[];
  kinds: Split<number>[];
  subcommands: Split<string>[];
  options: Split<string>[];
  /** Option values are strings, numbers or booleans: never JSON null, so never `null` as text. */
  optionValues: { _id: { o: string; v: string }; runs: number }[];
  memberTiers: Split<number | null>[];
  installs: Split<number | null>[];
  contexts: Split<number | null>[];
  channelTypes: Split<number>[];
  locales: Split<string>[];
  servers: Split<string>[];
  components: { _id: { k?: string; kind: number }; value: number }[];
  modals: { _id: string; shown: number; submitted: number }[];
}

const weightWhen = (condition: unknown) => ({ $sum: { $cond: [condition, '$weight', 0] } });

/** A breakdown by `key`, most runs first (ties by key), at most `limit` rows. */
const split = (key: unknown, where: object = {}, limit?: number) => [
  { $match: { base: true, ...where } },
  { $group: { _id: key, value: { $sum: '$weight' } } },
  { $sort: { value: -1, _id: 1 } },
  ...(limit === undefined ? [] : [{ $limit: limit }]),
];

/** Weights by whole milliseconds, rounded as `shardlens_hist_one` rounds them (`histogram.ts`). */
const msWeights = (field: string) => [
  { $match: { base: true, [field]: { $ne: null } } },
  { $group: { _id: `$${field}`, w: { $sum: { $round: ['$weight', 0] } } } },
];

async function command(m: Mongo, appId: string, spec: Spec<'command'>, now: Date): Promise<QueryAnswer<'command'>> {
  const from = await rawFrom(m, appId, new Date(spec.range.from), now);
  const ts = { $gte: from, $lt: new Date(spec.range.to) };
  const notMessage = { $ne: ['$kind', KIND.message_command] };
  const shown = { $and: ['$base', { $eq: ['$responseType', 9] }] };
  const [f] = await m.c.interactions
    .aggregate<CommandFacets>([
      {
        $match: {
          appId,
          ts,
          $or: [
            { command: spec.name, kind: { $in: COMMAND_KINDS } },
            // Buttons and select menus on the command's messages, and every modal submitted, for the modals it opened.
            { sourceCommand: spec.name, kind: { $in: [KIND.button, KIND.select] } },
            { kind: KIND.modal_submit, customId: { $exists: true } },
          ],
        },
      },
      {
        $addFields: {
          // A literal: a prefix command may be named `$weight`, which in an expression would be a field.
          base: { $and: [{ $eq: ['$command', { $literal: spec.name }] }, { $in: ['$kind', COMMAND_KINDS] }] },
        },
      },
      {
        $facet: {
          totals: [
            { $match: { base: true } },
            {
              $group: {
                _id: null,
                n: { $sum: 1 },
                runs: { $sum: '$weight' },
                ok: weightWhen({ $eq: ['$outcome', 0] }),
                error: weightWhen({ $eq: ['$outcome', 1] }),
                timeout: weightWhen({ $eq: ['$outcome', 2] }),
                noResponse: weightWhen({ $eq: ['$outcome', 3] }),
                deferred: weightWhen({ $eq: ['$deferred', true] }),
                ephemeral: weightWhen({ $eq: ['$ephemeral', true] }),
                premium: weightWhen({ $eq: ['$premium', true] }),
                interactions: weightWhen(notMessage),
                over3s: weightWhen({ $gt: ['$ackMs', 3000] }),
                answered: weightWhen({ $ne: [{ $ifNull: ['$ackMs', null] }, null] }),
                firstSeen: { $min: '$ts' },
                lastSeen: { $max: '$ts' },
              },
            },
          ],
          ack: msWeights('ackMs'),
          handler: msWeights('handlerMs'),
          kinds: split('$kind'),
          subcommands: split(
            {
              $concat: [
                { $cond: [{ $eq: [{ $ifNull: ['$cmdGroup', null] }, null] }, '', { $concat: ['$cmdGroup', ' '] }] },
                { $ifNull: ['$sub', ''] },
              ],
            },
            { $or: [{ sub: { $exists: true } }, { cmdGroup: { $exists: true } }] },
            50,
          ),
          options: [
            { $match: { base: true } },
            { $unwind: '$options' },
            { $group: { _id: '$options', value: { $sum: '$weight' } } },
            { $sort: { value: -1, _id: 1 } },
            { $limit: 50 },
          ],
          optionValues: [
            { $match: { base: true, optionValues: { $exists: true } } },
            { $project: { weight: 1, kv: { $objectToArray: '$optionValues' } } },
            { $unwind: '$kv' },
            { $group: { _id: { o: '$kv.k', v: jsonText('$kv.v') }, runs: { $sum: '$weight' } } },
            { $sort: { runs: -1, '_id.o': 1, '_id.v': 1 } },
            { $limit: 100 },
          ],
          memberTiers: split({ $ifNull: ['$memberTier', null] }),
          installs: split({ $ifNull: ['$install', null] }, { kind: { $ne: KIND.message_command } }),
          contexts: split({ $ifNull: ['$context', null] }),
          channelTypes: split('$channelType', { channelType: { $exists: true } }),
          locales: split('$locale', { locale: { $ne: '' } }, 15),
          servers: split('$guildId', { guildId: { $exists: true } }, 10),
          components: [
            { $match: { sourceCommand: spec.name, kind: { $in: [KIND.button, KIND.select] } } },
            { $group: { _id: { k: '$customId', kind: '$kind' }, value: { $sum: '$weight' } } },
            { $sort: { value: -1, '_id.k': 1, '_id.kind': 1 } },
            { $limit: 25 },
          ],
          modals: [
            {
              $match: {
                customId: { $exists: true },
                $or: [{ base: true, responseType: 9 }, { kind: KIND.modal_submit }],
              },
            },
            {
              $group: {
                _id: '$customId',
                shown: weightWhen(shown),
                opened: { $max: { $cond: [shown, 1, 0] } },
                submitted: weightWhen({ $eq: ['$kind', KIND.modal_submit] }),
              },
            },
            { $match: { opened: 1 } },
            { $sort: { shown: -1, _id: 1 } },
            { $limit: 20 },
          ],
        },
      },
    ])
    .toArray();
  if (!f) throw new Error('MongoStore: a $facet answered nothing');

  const t = f.totals[0];
  // `shardlens_hist_sum(shardlens_hist_one(ack_ms, weight))`: `NULL` when no run has a response time.
  let latency: number[] | null = null;
  for (const row of f.ack) {
    latency ??= new Array<number>(BUCKETS).fill(0);
    latency[bucketOf(row._id)]! += row.w;
  }
  const values = <K, V>(rows: Split<K>[], key: (k: K) => V) =>
    rows.map((r) => ({ key: key(r._id), value: real(r.value) }));
  const coded = (field: string) => (k: number | null) => (k === null ? null : decodeValue(field, String(k)));
  return {
    from: from.toISOString(),
    totals: {
      runs: t ? real(t.runs) : null,
      ok: realOrNull(t?.ok ?? 0, t?.n ?? 0),
      error: realOrNull(t?.error ?? 0, t?.n ?? 0),
      timeout: realOrNull(t?.timeout ?? 0, t?.n ?? 0),
      noResponse: realOrNull(t?.noResponse ?? 0, t?.n ?? 0),
      deferRate: realShare(t?.deferred ?? 0, t?.interactions ?? 0),
      ephemeralRate: realShare(t?.ephemeral ?? 0, t?.interactions ?? 0),
      premiumShare: realShare(t?.premium ?? 0, t?.interactions ?? 0),
      over3sRate: realShare(t?.over3s ?? 0, t?.answered ?? 0),
      handlerP95Ms: ackQuantile(f.handler, 0.95),
      firstSeen: t?.firstSeen ?? null,
      lastSeen: t?.lastSeen ?? null,
    },
    latencyHistogram: latency,
    kinds: values(f.kinds, (k) => decodeValue('kind', String(k))),
    subcommands: values(f.subcommands, String),
    options: values(f.options, String),
    optionValues: f.optionValues.map((r) => ({ option: r._id.o, value: r._id.v, runs: real(r.runs) })),
    memberTiers: values(f.memberTiers, coded('tier')),
    installs: values(f.installs, coded('install')),
    contexts: values(f.contexts, (k) => (k === null ? null : String(k))),
    channelTypes: values(f.channelTypes, String),
    locales: values(f.locales, String),
    topServers: await withGuildNames((app, ids) => guildProfiles(m, app, ids), appId, values(f.servers, String)),
    components: f.components.map((r) => ({
      key: r._id.k ?? null,
      kind: decodeValue('kind', String(r._id.kind)),
      value: real(r.value),
    })),
    modals: f.modals.map((r) => ({ customId: r._id, shown: real(r.shown), submitted: real(r.submitted) })),
  };
}

export function mongoCommandsQueries(m: Mongo): Pick<QueryStorage, 'commands' | 'command'> {
  return {
    commands: (appId, spec, now) => commands(m, appId, spec, now),
    command: (appId, spec, now) => command(m, appId, spec, now),
  };
}
