import { BUCKETS, bucketOf } from '@shardlens/core';
import { COMMAND_KINDS, KIND, OUTCOME } from '../../../ingest/codes.js';
import { decodeValue } from '../../../query/dimensions.js';
import { withGuildNames } from '../../../query/guild-names.js';
import type { Spec } from '../../../query/spec.js';
import type { QueryAnswer, QueryStorage } from '../../store.js';
import type { Mongo } from '../connect.js';
import { ackQuantile, msWeights } from '../histogram.js';
import { guildProfiles } from './guild-profiles.js';
import { idPrefix } from './id-prefix.js';
import { byteOrder, jsonText, roundTenths } from './pg-values.js';
import { rawFrom, rollupSource } from './read-window.js';
import {
  type CountsByWeight,
  countWhenRan,
  type KeyWeights,
  realRatio,
  realSumOf,
  summed,
  weightsBy,
} from './real-sums.js';
import { dim, HIST_ARRAY, HIST_SUMS, histQuantile } from './rollup-reads.js';
import { currentPeriodStart } from './salt-period-start.js';

/*
 * The command list (from rollups) and one command's page (from single events), as `postgres/query/pages.ts` answers
 * them. Each answer section PostgreSQL reads with its own statement is a `$facet` of one aggregation here.
 */

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

type TotalsFigure =
  | 'runs'
  | 'ok'
  | 'error'
  | 'timeout'
  | 'noResponse'
  | 'deferred'
  | 'ephemeral'
  | 'premium'
  | 'interactions'
  | 'over3s'
  | 'answered';

interface CommandFacets {
  totals: (CountsByWeight<TotalsFigure> & { firstSeen: Date; lastSeen: Date })[];
  ack: { _id: number; w: number }[];
  handler: { _id: number; w: number }[];
  kinds: KeyWeights<number>[];
  subcommands: KeyWeights<string>[];
  options: KeyWeights<string>[];
  /** Option values are strings, numbers or booleans: never JSON null, so never `null` as text. */
  optionValues: KeyWeights<{ o: string; v: string }>[];
  memberTiers: KeyWeights<number | null>[];
  installs: KeyWeights<number | null>[];
  contexts: KeyWeights<number | null>[];
  channelTypes: KeyWeights<number>[];
  locales: KeyWeights<string>[];
  servers: KeyWeights<string>[];
  components: KeyWeights<{ k?: string; kind: number }>[];
  modals: { _id: string; weights: CountsByWeight<'shown' | 'submitted'>[] }[];
}

const countIf = (condition: unknown) => ({ $sum: { $cond: [condition, 1, 0] } });

/** A breakdown of the command's runs by `key`, at most `limit` rows. */
const split = (key: unknown, where: object = {}, limit?: number) => [
  { $match: { base: true, ...where } },
  ...weightsBy(key, limit),
];

async function command(m: Mongo, appId: string, spec: Spec<'command'>, now: Date): Promise<QueryAnswer<'command'>> {
  const from = await rawFrom(m, appId, new Date(spec.range.from), now);
  const ts = { $gte: from, $lt: new Date(spec.range.to) };
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
                _id: '$weight',
                runs: { $sum: 1 },
                ok: countIf({ $eq: ['$outcome', OUTCOME.ok] }),
                error: countIf({ $eq: ['$outcome', OUTCOME.error] }),
                timeout: countIf({ $eq: ['$outcome', OUTCOME.timeout] }),
                noResponse: countIf({ $eq: ['$outcome', OUTCOME.no_response] }),
                deferred: countIf({ $eq: ['$deferred', true] }),
                ephemeral: countIf({ $eq: ['$ephemeral', true] }),
                premium: countIf({ $eq: ['$premium', true] }),
                interactions: countIf({ $ne: ['$kind', KIND.message_command] }),
                over3s: countIf({ $gt: ['$ackMs', 3000] }),
                answered: countIf({ $ne: [{ $ifNull: ['$ackMs', null] }, null] }),
                firstSeen: { $min: '$ts' },
                lastSeen: { $max: '$ts' },
              },
            },
          ],
          ack: msWeights('ackMs', { base: true }),
          handler: msWeights('handlerMs', { base: true }),
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
          options: [{ $match: { base: true } }, { $unwind: '$options' }, ...weightsBy('$options', 50)],
          optionValues: [
            { $match: { base: true, optionValues: { $exists: true } } },
            { $project: { weight: 1, kv: { $objectToArray: '$optionValues' } } },
            { $unwind: '$kv' },
            ...weightsBy({ o: '$kv.k', v: jsonText('$kv.v') }, 100),
          ],
          memberTiers: split({ $ifNull: ['$memberTier', null] }),
          installs: split({ $ifNull: ['$install', null] }, { kind: { $ne: KIND.message_command } }),
          contexts: split({ $ifNull: ['$context', null] }),
          channelTypes: split('$channelType', { channelType: { $exists: true } }),
          locales: split('$locale', { locale: { $ne: '' } }, 15),
          servers: split('$guildId', { guildId: { $exists: true } }, 10),
          components: [
            { $match: { sourceCommand: spec.name, kind: { $in: [KIND.button, KIND.select] } } },
            ...weightsBy({ k: '$customId', kind: '$kind' }, 25),
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
                _id: { k: '$customId', w: '$weight' },
                shown: countIf(shown),
                submitted: countIf({ $eq: ['$kind', KIND.modal_submit] }),
              },
            },
            {
              $group: {
                _id: '$_id.k',
                weights: { $push: { _id: '$_id.w', shown: '$shown', submitted: '$submitted' } },
                approx: { $sum: { $multiply: ['$_id.w', '$shown'] } },
              },
            },
            // The modals the command opened, ordered and cut as `weightsBy` orders and cuts keys.
            { $match: { approx: { $gt: 0 } } },
            { $sort: { approx: -1, _id: 1 } },
            { $limit: 20 },
          ],
        },
      },
    ])
    .toArray();
  if (!f) throw new Error('MongoStore: a $facet answered nothing');

  const runs = f.totals;
  const sum = (figure: TotalsFigure) => realSumOf(runs, figure);
  // `shardlens_hist_sum(shardlens_hist_one(ack_ms, weight))`: `NULL` when no run has a response time.
  let latency: number[] | null = null;
  for (const row of f.ack) {
    latency ??= new Array<number>(BUCKETS).fill(0);
    latency[bucketOf(row._id)]! += row.w;
  }
  const values = <K, V>(rows: KeyWeights<K>[], key: (k: K) => V) =>
    summed(rows).map((r) => ({ key: key(r.key), value: r.value }));
  const coded = (field: string) => (k: number | null) => (k === null ? null : decodeValue(field, String(k)));
  return {
    from: from.toISOString(),
    totals: {
      runs: sum('runs'),
      ok: countWhenRan(runs, 'ok'),
      error: countWhenRan(runs, 'error'),
      timeout: countWhenRan(runs, 'timeout'),
      noResponse: countWhenRan(runs, 'noResponse'),
      deferRate: realRatio(sum('deferred') ?? 0, sum('interactions')),
      ephemeralRate: realRatio(sum('ephemeral') ?? 0, sum('interactions')),
      premiumShare: realRatio(sum('premium') ?? 0, sum('interactions')),
      over3sRate: realRatio(sum('over3s') ?? 0, sum('answered')),
      handlerP95Ms: ackQuantile(f.handler, 0.95),
      firstSeen: runs.reduce<Date | null>((first, g) => (first && first <= g.firstSeen ? first : g.firstSeen), null),
      lastSeen: runs.reduce<Date | null>((last, g) => (last && last >= g.lastSeen ? last : g.lastSeen), null),
    },
    latencyHistogram: latency,
    kinds: values(f.kinds, (k) => decodeValue('kind', String(k))),
    subcommands: values(f.subcommands, String),
    options: values(f.options, String),
    optionValues: summed(f.optionValues).map((r) => ({ option: r.key.o, value: r.key.v, runs: r.value })),
    memberTiers: values(f.memberTiers, coded('tier')),
    installs: values(f.installs, coded('install')),
    contexts: values(f.contexts, (k) => (k === null ? null : String(k))),
    channelTypes: values(f.channelTypes, String),
    locales: values(f.locales, String),
    topServers: await withGuildNames((app, ids) => guildProfiles(m, app, ids), appId, values(f.servers, String)),
    components: summed(f.components).map((r) => ({
      key: r.key.k ?? null,
      kind: decodeValue('kind', String(r.key.kind)),
      value: r.value,
    })),
    modals: f.modals
      .map((r) => ({
        customId: r._id,
        shown: realSumOf(r.weights, 'shown') ?? 0,
        submitted: realSumOf(r.weights, 'submitted') ?? 0,
      }))
      .sort((a, b) => b.shown - a.shown),
  };
}

export function mongoCommandsQueries(m: Mongo): Pick<QueryStorage, 'commands' | 'command'> {
  return {
    commands: (appId, spec, now) => commands(m, appId, spec, now),
    command: (appId, spec, now) => command(m, appId, spec, now),
  };
}
