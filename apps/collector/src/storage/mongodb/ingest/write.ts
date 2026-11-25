import { createHash } from 'node:crypto';
import type { Event } from '@shardlens/schema';
import { Binary, type Collection, type Document, type OptionalUnlessRequiredId, UUID } from 'mongodb';
import { COMMAND_SCOPE, INSTALL, KIND, MEMBER_TIER, OUTCOME, parseUserHash } from '../../../ingest/codes.js';
import type { IngestContext, IngestItem, IngestStorage, SealedActor, WriteResult } from '../../store.js';
import type {
  AppInfoDoc,
  AuditLogDoc,
  CommandPermissionDoc,
  CustomEventDoc,
  EntitlementDoc,
  GaugeDoc,
  InteractionDoc,
  InteractionErrorDoc,
  RateLimitDoc,
  RestCallDoc,
  RestInvalidDoc,
  ShardEventDoc,
  SubscriptionDoc,
  UniqueDoc,
} from '../collections.js';
import type { Mongo } from '../connect.js';
import { isDuplicateKey } from '../duplicate-key.js';
import { uniqueId } from '../uniques.js';
import { compact, insertNew, refusedInput } from '../writes.js';
import { applyGuildEvents, type GuildEvent, recordCommandActivity } from './guilds.js';
import { applySnapshot } from './snapshots.js';

/** Minutes older than this when they arrive are marked dirty so the rollup job recomputes them. */
const LATE_MS = 2 * 60_000;

const minute = (ts: number) => Math.floor(ts / 60_000) * 60_000;

/** PostgreSQL keeps weights as `real`: rounded the same, sums and histogram weights come out the same. */
const weight = (w: number) => Math.fround(w);

const gaugeId = (appId: string, name: string, shard: number, instance: string, ts: Date): GaugeDoc['_id'] => ({
  appId,
  name,
  shard,
  instance,
  ts,
});

/**
 * Entitlements come from the gateway (here) and from webhook events (`webhook-events.ts`). The `_id` stands for
 * PostgreSQL's unique key (app, time, SKU, action, user, server), NULLs equal.
 */
export function entitlementDoc(e: {
  appId: string;
  ts: Date;
  action: string;
  skuId: string;
  entitlementType: number;
  owner: string;
  userHash: Buffer | null;
  guildId: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  source: EntitlementDoc['source'];
}): EntitlementDoc {
  const key = JSON.stringify([
    e.appId,
    e.ts.getTime(),
    e.skuId,
    e.action,
    e.userHash?.toString('hex') ?? null,
    e.guildId,
  ]);
  return compact<EntitlementDoc>({
    _id: new Binary(createHash('sha256').update(key).digest()),
    appId: e.appId,
    ts: e.ts,
    action: e.action,
    skuId: e.skuId,
    entitlementType: e.entitlementType,
    owner: e.owner,
    userHash: e.userHash && new Binary(e.userHash),
    guildId: e.guildId,
    startsAt: e.startsAt,
    endsAt: e.endsAt,
    source: e.source,
  });
}

const emptyResult = (): WriteResult => ({ accepted: 0, duplicates: 0, rejected: [], stored: new Set() });

/** Events applied in batch order, after the single events are stored. */
type Ordered = Extract<
  Event,
  {
    type:
      | 'guild_join'
      | 'guild_update'
      | 'guild_leave'
      | 'guild_availability'
      | 'guild_snapshot'
      | 'command_registry'
      | 'app_info'
      | 'sdk_health';
  }
>;

const GUILD_EVENTS = new Set<Ordered['type']>(['guild_join', 'guild_update', 'guild_leave', 'guild_availability']);
const isGuildEvent = (e: Ordered): e is GuildEvent => GUILD_EVENTS.has(e.type);

/**
 * Writes one validated batch. There is no transaction: each single event is stored once by its UUIDv7 `_id` (a
 * duplicate key is a retried event), and everything else is an upsert or conditional update that a retry of the
 * batch repeats harmlessly, so a batch that failed partway is completed by the SDK sending it again. The collections
 * are written concurrently, one round trip each: insertMany for single events, bulkWrite for upserts.
 */
async function writeEvents(m: Mongo, ctx: IngestContext, items: readonly IngestItem[]): Promise<WriteResult> {
  const { c } = m;
  const { appId } = ctx;
  const result = emptyResult();
  const dirty = new Set<number>();
  const markLate = (ts: number) => {
    if (ctx.now.getTime() - ts > LATE_MS) dirty.add(minute(ts));
  };
  const userHash = (index: number, hash: string | undefined): { period: string; bytes: Buffer } | null | undefined => {
    if (hash === undefined) return undefined;
    const parsed = parseUserHash(hash);
    if (!parsed || !ctx.livePeriods.has(parsed.period)) {
      result.rejected.push({ index, reason: 'unknown_salt_period' });
      return null;
    }
    return parsed;
  };

  const interactions: InteractionDoc[] = [];
  /** The ID each interaction document was sent with, for `stored` and the mirror. */
  const interactionIds: string[] = [];
  /** By `_id`, so each is written once per batch. */
  const uniques = new Map<string, UniqueDoc['_id']>();
  const commandRuns: { guild: string; ts: Date }[] = [];
  const audit: AuditLogDoc[] = [];
  const errors: InteractionErrorDoc[] = [];
  const restCalls: RestCallDoc[] = [];
  const restInvalid: RestInvalidDoc[] = [];
  const rateLimits: RateLimitDoc[] = [];
  const custom: CustomEventDoc[] = [];
  const customIds: string[] = [];
  const gauges: GaugeDoc[] = [];
  const shardEvents: ShardEventDoc[] = [];
  const entitlements: EntitlementDoc[] = [];
  const subscriptions: SubscriptionDoc[] = [];
  const permissions: CommandPermissionDoc[] = [];
  const ordered: Ordered[] = [];
  let singleRowEvents = 0;

  /**
   * One run's unique-user documents (everyone, the command, the server, plus `extra` scopes) and, unless it was
   * autocomplete, the server's first and last activity.
   */
  const countRun = (
    user: { period: string; bytes: Buffer },
    ts: Date,
    command: string | undefined,
    guild: string | undefined,
    activity: boolean,
    extra: readonly [string, string][],
  ) => {
    const day = ts.toISOString().slice(0, 10);
    const scopes: [string, string][] = [['global', '*']];
    if (command) scopes.push(['command', command]);
    if (guild) scopes.push(['guild', guild]);
    scopes.push(...extra);
    const hash = new Binary(user.bytes);
    const hex = user.bytes.toString('hex');
    for (const [scope, key] of scopes) {
      uniques.set(
        JSON.stringify([user.period, scope, key, day, hex]),
        uniqueId(appId, user.period, scope, key, day, hash),
      );
    }
    if (guild && activity) commandRuns.push({ guild, ts });
  };

  /** Who ran a command, already encrypted: only in audit mode, within audit retention. */
  const recordActor = (
    actor: SealedActor | undefined,
    e: Extract<Event, { type: 'interaction' | 'message_command' }>,
    ts: Date,
    kind: number,
    customId: string | undefined,
    ackMs: number | undefined,
  ) => {
    if (!actor) return;
    audit.push(
      compact<AuditLogDoc>({
        _id: new UUID(e.id),
        ts,
        appId,
        actorLookup: new Binary(actor.lookup),
        actorEnc: new Binary(actor.userId),
        namesEnc: actor.profile && new Binary(actor.profile),
        guildId: e.guild,
        kind,
        command: e.command,
        sub: e.sub,
        customId,
        outcome: OUTCOME[e.outcome],
        ackMs,
      }),
    );
  };

  for (const { index, event: e, actor } of items) {
    const ts = new Date(e.ts);
    switch (e.type) {
      case 'interaction': {
        const user = userHash(index, e.user);
        if (!user) continue;
        markLate(e.ts);
        interactionIds.push(e.id);
        interactions.push(
          compact<InteractionDoc>({
            _id: new UUID(e.id),
            ts,
            appId,
            env: ctx.env,
            release: ctx.release,
            kind: KIND[e.kind],
            command: e.command,
            cmdGroup: e.group,
            sub: e.sub,
            commandId: e.commandId,
            commandScope: e.commandScope ? COMMAND_SCOPE[e.commandScope] : undefined,
            options: e.options,
            optionValues: e.optionValues,
            customId: e.customId,
            componentType: e.componentType,
            sourceCommand: e.sourceCommand,
            context: e.context,
            install: e.install ? INSTALL[e.install] : undefined,
            guildId: e.guild,
            channelType: e.channelType,
            locale: e.locale,
            guildLocale: e.guildLocale,
            memberTier: e.memberTier ? MEMBER_TIER[e.memberTier] : undefined,
            userHash: new Binary(user.bytes),
            saltPeriod: user.period,
            premium: e.premium,
            outcome: OUTCOME[e.outcome],
            errorCode: e.errorCode,
            errorClass: e.errorClass,
            ackMs: e.ackMs,
            responseType: e.responseType,
            deferred: e.deferred,
            ephemeral: e.ephemeral,
            handlerMs: e.handlerMs,
            shard: e.shard,
            weight: weight(e.weight),
          }),
        );
        const command = e.kind === 'autocomplete' ? undefined : e.command;
        const extra: [string, string][] = [['locale', e.locale]];
        if (e.install) extra.push(['install', e.install]);
        countRun(user, ts, command, e.guild, e.kind !== 'autocomplete', extra);
        recordActor(actor, e, ts, KIND[e.kind], e.customId, e.ackMs);
        break;
      }
      case 'message_command': {
        const user = userHash(index, e.user);
        if (!user) continue;
        markLate(e.ts);
        // Stored with interactions so every command view counts it. A message has no user language, install type,
        // entitlements or response, so those fields hold empty values that the deadline and premium figures skip.
        interactionIds.push(e.id);
        interactions.push(
          compact<InteractionDoc>({
            _id: new UUID(e.id),
            ts,
            appId,
            env: ctx.env,
            release: ctx.release,
            kind: KIND.message_command,
            command: e.command,
            cmdGroup: e.group,
            sub: e.sub,
            options: e.options,
            optionValues: e.optionValues,
            context: e.guild ? 0 : 1,
            guildId: e.guild,
            channelType: e.channelType,
            locale: '',
            guildLocale: e.guildLocale,
            memberTier: e.memberTier ? MEMBER_TIER[e.memberTier] : undefined,
            userHash: new Binary(user.bytes),
            saltPeriod: user.period,
            premium: false,
            outcome: OUTCOME[e.outcome],
            errorCode: e.errorCode,
            errorClass: e.errorClass,
            handlerMs: e.handlerMs,
            shard: e.shard,
            weight: weight(e.weight),
          }),
        );
        countRun(user, ts, e.command, e.guild, true, []);
        recordActor(actor, e, ts, KIND.message_command, undefined, undefined);
        break;
      }
      case 'interaction_error':
        markLate(e.ts);
        errors.push(
          compact<InteractionErrorDoc>({
            _id: new UUID(e.id),
            ts,
            appId,
            interactionId: new UUID(e.interaction),
            command: e.command,
            errorClass: e.errorClass,
            errorCode: e.errorCode,
            handlerMs: e.handlerMs,
            weight: weight(e.weight),
          }),
        );
        break;
      case 'rest_window': {
        markLate(e.ts);
        const eventId = new UUID(e.id);
        e.rows.forEach((r, row) => {
          restCalls.push({
            _id: { eventId, row },
            ts,
            appId,
            method: r.method,
            route: r.route,
            status: r.status,
            count: r.count,
            retries: r.retries,
            hist: r.latency,
            weight: weight(e.weight),
          });
        });
        restInvalid.push({ _id: eventId, ts, appId, ...e.invalid });
        break;
      }
      case 'rate_limit':
        markLate(e.ts);
        rateLimits.push({
          _id: new UUID(e.id),
          ts,
          appId,
          scope: e.scope,
          global: e.global,
          route: e.route,
          method: e.method,
          retryAfter: e.retryAfter,
        });
        break;
      case 'invalid_request_warning':
        gauges.push({ _id: gaugeId(appId, 'rest.invalid_warning_count', -1, ctx.instance, ts), value: e.count });
        singleRowEvents++;
        break;
      case 'gauge_window':
        for (const g of e.gauges)
          gauges.push({ _id: gaugeId(appId, g.name, g.shard ?? -1, ctx.instance, ts), value: g.value });
        singleRowEvents++;
        break;
      case 'custom': {
        const user = userHash(index, e.user);
        if (user === null) continue;
        markLate(e.ts);
        customIds.push(e.id);
        custom.push(
          compact<CustomEventDoc>({
            _id: new UUID(e.id),
            ts,
            appId,
            name: e.name,
            props: e.props,
            userHash: user && new Binary(user.bytes),
            guildId: e.guild,
            weight: weight(e.weight),
          }),
        );
        break;
      }
      case 'shard_state':
        shardEvents.push(
          compact<ShardEventDoc>({
            _id: { appId, shard: e.shard, ts, state: e.state },
            closeCode: e.closeCode,
            replayed: e.replayed,
          }),
        );
        break;
      case 'entitlement': {
        const user = userHash(index, e.user);
        if (user === null) continue;
        entitlements.push(
          entitlementDoc({
            appId,
            ts,
            action: e.action,
            skuId: e.sku,
            entitlementType: e.entitlementType,
            owner: e.owner,
            userHash: user?.bytes ?? null,
            guildId: e.guild ?? null,
            startsAt: e.startsAt === null ? null : new Date(e.startsAt),
            endsAt: e.endsAt === null ? null : new Date(e.endsAt),
            source: 'gateway',
          }),
        );
        markLate(e.ts);
        break;
      }
      case 'subscription': {
        const user = userHash(index, e.user);
        if (!user) continue;
        subscriptions.push({
          _id: new UUID(e.id),
          ts,
          appId,
          action: e.action,
          status: e.status,
          skuIds: e.skus,
          userHash: new Binary(user.bytes),
          periodStart: new Date(e.periodStart),
          periodEnd: new Date(e.periodEnd),
        });
        markLate(e.ts);
        break;
      }
      case 'command_permissions':
        permissions.push({
          _id: new UUID(e.id),
          ts,
          appId,
          guildId: e.guild,
          commandId: e.command,
          overwrites: e.overwrites,
        });
        break;
      case 'app_info': {
        const reported: [string, number | null | undefined][] = [
          ['app.approx_guilds', e.approximateGuildCount],
          ['app.approx_user_installs', e.approximateUserInstallCount],
          ['identify.remaining', e.sessionStartRemaining],
        ];
        for (const [name, value] of reported) {
          if (typeof value === 'number') gauges.push({ _id: gaugeId(appId, name, -1, ctx.instance, ts), value });
        }
        ordered.push(e);
        break;
      }
      case 'guild_join':
      case 'guild_leave':
      case 'guild_availability':
        markLate(e.ts);
        ordered.push(e);
        break;
      default:
        ordered.push(e);
    }
  }

  /** Stores single events: one stored before is a retried event. `onFresh` gets the position of each stored now. */
  const counted = async <T extends Document>(
    collection: Collection<T>,
    docs: OptionalUnlessRequiredId<T>[],
    onFresh?: (i: number) => void,
  ) => {
    const fresh = await insertNew(collection, docs);
    result.accepted += fresh.size;
    result.duplicates += docs.length - fresh.size;
    if (onFresh) for (const i of fresh) onFresh(i);
  };
  const freshInteractions: number[] = [];
  const freshCustom: number[] = [];

  const settled = await Promise.allSettled([
    counted(c.interactions, interactions, (i) => {
      freshInteractions.push(i);
      result.stored.add(interactionIds[i]!.toLowerCase());
    }),
    upsertUniques(m, [...uniques.values()]),
    insertNew(c.auditLog, audit),
    counted(c.interactionErrors, errors),
    insertNew(c.restCalls, restCalls),
    counted(c.restInvalid, restInvalid),
    counted(c.rateLimits, rateLimits),
    counted(c.customEvents, custom, (i) => freshCustom.push(i)),
    insertNew(c.gauges, gauges),
    counted(c.shardEvents, shardEvents),
    counted(c.entitlements, entitlements),
    counted(c.subscriptions, subscriptions),
    counted(c.commandPermissions, permissions),
    (async () => {
      await applyOrdered(m, ctx, ordered, result);
      // After joins and leaves: a run after a removal in the same batch doesn't count.
      await recordCommandActivity(m, appId, commandRuns);
    })(),
  ]);
  const failed = settled.find((s) => s.status === 'rejected');
  if (failed) throw failed.reason;
  result.accepted += singleRowEvents;

  // Only rows stored now are mirrored, so retried batches are never counted twice in ClickHouse.
  if (ctx.mirror) {
    result.mirror = {
      interactions: freshInteractions.map((i) => {
        const d = interactions[i]!;
        return {
          id: interactionIds[i]!,
          ts: d.ts,
          appId,
          kind: d.kind,
          command: d.command ?? null,
          sub: d.sub ?? null,
          outcome: d.outcome,
          context: d.context ?? null,
          install: d.install ?? null,
          guildId: d.guildId ?? null,
          locale: d.locale,
          tier: d.memberTier ?? null,
          userHash: Buffer.from(d.userHash.buffer),
          ackMs: d.ackMs ?? null,
          weight: d.weight,
        };
      }),
      custom: freshCustom.map((i) => {
        const d = custom[i]!;
        return {
          id: customIds[i]!,
          ts: d.ts,
          appId,
          name: d.name,
          userHash: d.userHash ? Buffer.from(d.userHash.buffer) : null,
          guildId: d.guildId ?? null,
          weight: d.weight,
        };
      }),
    };
  }

  // Last, once the events are stored: a rollup run that read the minute before they were must find it marked again.
  if (dirty.size > 0) {
    await c.dirtyBuckets.bulkWrite(
      [...dirty].map((bucket) => ({
        updateOne: { filter: { _id: { appId, bucket: new Date(bucket) } }, update: { $inc: { n: 1 } }, upsert: true },
      })),
      { ordered: false },
    );
  }
  return result;
}

/** Unique-user documents, many of them there already (the same people run commands all day): only the new ones write. */
async function upsertUniques(m: Mongo, ids: UniqueDoc['_id'][]): Promise<void> {
  if (ids.length === 0) return;
  await m.c.uniques.bulkWrite(
    ids.map((_id) => ({ updateOne: { filter: { _id }, update: { $setOnInsert: {} }, upsert: true } })),
    { ordered: false },
  );
}

/** Server events, snapshots, the command registry, app info and SDK health, in batch order. */
async function applyOrdered(m: Mongo, ctx: IngestContext, ordered: readonly Ordered[], result: WriteResult) {
  let run: GuildEvent[] = [];
  const flush = async () => {
    if (run.length > 0) await applyGuildEvents(m, ctx.appId, run, ctx.now, result);
    run = [];
  };
  for (const e of ordered) {
    if (isGuildEvent(e)) {
      run.push(e);
      continue;
    }
    await flush();
    const ts = new Date(e.ts);
    switch (e.type) {
      case 'guild_snapshot':
        await applySnapshot(m, ctx.appId, ts, e, ctx.now);
        break;
      case 'command_registry':
        await applyRegistry(m, ctx.appId, e.commands, ctx.now);
        break;
      case 'app_info':
        await applyAppInfo(m, ctx, e);
        break;
      case 'sdk_health':
        await newerOnly(
          m.c.sdkHealth.updateOne(
            { _id: { appId: ctx.appId, instance: ctx.instance }, ts: { $lte: ts } },
            {
              $set: {
                ts,
                shards: ctx.shards,
                queueDepth: e.queueDepth,
                dropped: e.dropped,
                failedFlushes: e.failedFlushes,
                internalErrors: e.internalErrors,
                sdkVersion: ctx.sdkVersion,
              },
            },
            { upsert: true },
          ),
        );
        break;
    }
    result.accepted++;
  }
  await flush();
}

/**
 * A write of the newest report of something: its filter matches a stored one no newer, else it inserts, which a newer
 * stored report refuses as a duplicate. `false` when that happened.
 */
async function newerOnly(write: Promise<unknown>): Promise<boolean> {
  try {
    await write;
    return true;
  } catch (error) {
    if (isDuplicateKey(error)) return false;
    throw error;
  }
}

async function applyRegistry(
  m: Mongo,
  appId: string,
  listed: { id: string; name: string; type: number; guild?: string | undefined; subcommands: string[] }[],
  now: Date,
) {
  // A command listed twice: the last one wins.
  const commands = [...new Map(listed.map((cmd) => [cmd.id, cmd])).values()];
  if (commands.length > 0) {
    await m.c.commandRegistry.bulkWrite(
      commands.map((cmd) => ({
        updateOne: {
          filter: { _id: { appId, commandId: cmd.id } },
          update: {
            $set: { name: cmd.name, type: cmd.type, subcommands: cmd.subcommands, lastSeen: now },
            $setOnInsert: cmd.guild === undefined ? { firstSeen: now } : { firstSeen: now, guildId: cmd.guild },
          },
          upsert: true,
        },
      })),
      { ordered: false },
    );
  }
  // The registry lists global commands; drop global ones that were unregistered.
  await m.c.commandRegistry.deleteMany({
    '_id.appId': appId,
    guildId: { $exists: false },
    '_id.commandId': { $nin: commands.filter((cmd) => !cmd.guild).map((cmd) => cmd.id) },
  });
}

async function applyAppInfo(m: Mongo, ctx: IngestContext, e: Extract<Event, { type: 'app_info' }>) {
  const ts = new Date(e.ts);
  // Every field, as PostgreSQL's upsert sets every column: one this report has no value for is cleared.
  const fields: { [K in keyof Omit<AppInfoDoc, '_id'>]-?: AppInfoDoc[K] | null | undefined } = {
    ts,
    name: e.name,
    approxGuilds: e.approximateGuildCount,
    approxUserInstalls: e.approximateUserInstallCount,
    approxUserAuths: e.approximateUserAuthorizationCount,
    dashboardUserIds: e.dashboardUserIds,
    eventWebhooksStatus: e.eventWebhooksStatus,
    skus: e.skus,
    sessionStartRemaining: e.sessionStartRemaining,
    sessionStartTotal: e.sessionStartTotal,
    nodeVersion: e.nodeVersion,
    libVersion: e.libVersion,
    sdkVersion: ctx.sdkVersion,
    release: ctx.release,
  };
  const set = compact<Omit<AppInfoDoc, '_id'>>(fields);
  const unset = Object.fromEntries(Object.keys(fields).flatMap((key) => (key in set ? [] : [[key, '' as const]])));
  const newest = await newerOnly(
    m.c.appInfo.updateOne({ _id: ctx.appId, ts: { $lte: ts } }, { $set: set, $unset: unset }, { upsert: true }),
  );
  // A report older than the stored one (a late retry) must not bring back an old name.
  if (newest) {
    await m.c.apps.updateOne(
      { _id: ctx.appId, $or: [{ nameAt: { $exists: false } }, { nameAt: { $lte: ts } }] },
      { $set: { name: e.name, nameAt: ts } },
    );
  }
}

/**
 * As `writeEvents`, one event at a time, after the batch failed on input MongoDB refused. Events the failed attempt
 * stored already come back as duplicates.
 */
async function writeEachEvent(m: Mongo, ctx: IngestContext, items: readonly IngestItem[]): Promise<WriteResult> {
  const total = emptyResult();
  for (const item of items) {
    let one: WriteResult;
    try {
      one = await writeEvents(m, ctx, [item]);
    } catch (error) {
      if (refusedInput(error) === undefined) throw error;
      total.rejected.push({ index: item.index, reason: 'refused_by_database' });
      continue;
    }
    total.accepted += one.accepted;
    total.duplicates += one.duplicates;
    total.rejected.push(...one.rejected);
    for (const id of one.stored) total.stored.add(id);
    if (one.mirror) {
      total.mirror ??= { interactions: [], custom: [] };
      total.mirror.interactions.push(...one.mirror.interactions);
      total.mirror.custom.push(...one.mirror.custom);
    }
  }
  return total;
}

export function mongoIngest(m: Mongo): IngestStorage {
  return {
    write: (ctx, items) => writeEvents(m, ctx, items),
    writeEach: (ctx, items) => writeEachEvent(m, ctx, items),
  };
}
