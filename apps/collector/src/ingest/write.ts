import type { Event } from '@shardlens/schema';
import { insertRows, isRefusedInput, type Tx } from '../db.js';
import type { auditCipher } from '../security/crypto.js';
import type { MirroredCustom, MirroredInteraction } from '../storage/clickhouse.js';
import { ensureUniquesPartition } from '../storage/maintenance.js';
import { COMMAND_SCOPE, GUILD_EVENT, INSTALL, KIND, MEMBER_TIER, OUTCOME, parseUserHash } from './codes.js';
import { applyGuildJoin, applyGuildLeave, applyGuildUpdate, applySnapshot, recordGuildEvent } from './guilds.js';

interface IngestContext {
  appId: string;
  env: string;
  release: string | undefined;
  instance: string;
  shards: number[];
  sdkVersion: string;
  /** Salt periods whose salt is alive: hashes from any other period are refused. */
  livePeriods: Set<string>;
  /** Present only when the batch and the app are both in audit mode and the audit key is configured. */
  audit?: { cipher: ReturnType<typeof auditCipher>; oldestMs: number } | undefined;
  now: Date;
  /** Collect accepted interactions and custom events for the ClickHouse analytics store. */
  mirror?: boolean | undefined;
}

/** An event plus its position in the submitted batch (for per-event rejections). */
export interface Indexed {
  index: number;
  event: Event;
}

interface WriteResult {
  accepted: number;
  duplicates: number;
  rejected: { index: number; reason: string }[];
  /** IDs (lower case) of the interactions and message commands this batch stored: retried ones are left out. */
  stored: Set<string>;
  /** Rows PostgreSQL accepted (never retries), when `ctx.mirror` is set. */
  mirror?: { interactions: MirroredInteraction[]; custom: MirroredCustom[] } | undefined;
}

/** Minutes older than this when they arrive are marked dirty so the rollup job recomputes them. */
const LATE_MS = 2 * 60_000;

const minute = (ts: number) => new Date(Math.floor(ts / 60_000) * 60_000);

const INTERACTION_COLUMNS = [
  'id',
  'ts',
  'app_id',
  'env',
  'release',
  'kind',
  'command',
  'cmd_group',
  'sub',
  'command_id',
  'command_scope',
  'options',
  'option_values',
  'custom_id',
  'component_type',
  'source_command',
  'context',
  'install',
  'guild_id',
  'channel_type',
  'locale',
  'guild_locale',
  'member_tier',
  'user_hash',
  'salt_period',
  'premium',
  'outcome',
  'error_code',
  'error_class',
  'ack_ms',
  'response_type',
  'deferred',
  'ephemeral',
  'handler_ms',
  'shard',
  'weight',
] as const;
const GAUGE_COLUMNS = ['app_id', 'ts', 'name', 'shard', 'instance', 'value'];

/** Entitlements come from the gateway (here) and from webhook events (`routes/discord-events.ts`). */
export const ENTITLEMENT_COLUMNS = [
  'app_id',
  'ts',
  'action',
  'sku_id',
  'entitlement_type',
  'owner',
  'user_hash',
  'guild_id',
  'starts_at',
  'ends_at',
  'source',
];

/** Position of each column in an `interactions` row, for the ClickHouse mirror. */
const AT = Object.fromEntries(INTERACTION_COLUMNS.map((c, i) => [c, i])) as Record<
  (typeof INTERACTION_COLUMNS)[number],
  number
>;

/**
 * Writes a batch one event at a time, each under a savepoint, after the batch as a whole failed on a value PostgreSQL
 * refused (a number wider than its column, say): only the events it refuses are rejected, not the whole batch.
 */
export async function writeEachEvent(tx: Tx, ctx: IngestContext, items: readonly Indexed[]): Promise<WriteResult> {
  const total: WriteResult = { accepted: 0, duplicates: 0, rejected: [], stored: new Set() };
  for (const item of items) {
    await tx.query('SAVEPOINT one_event');
    let one: WriteResult;
    try {
      one = await writeEvents(tx, ctx, [item]);
    } catch (error) {
      if (!isRefusedInput(error)) throw error;
      await tx.query('ROLLBACK TO SAVEPOINT one_event');
      total.rejected.push({ index: item.index, reason: 'refused_by_database' });
      continue;
    }
    await tx.query('RELEASE SAVEPOINT one_event');
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

/**
 * Writes one validated batch in the caller's transaction. Every insert is idempotent (`ON CONFLICT DO NOTHING` on the
 * UUIDv7 event ID), so a retried batch is counted once.
 */
export async function writeEvents(tx: Tx, ctx: IngestContext, items: readonly Indexed[]): Promise<WriteResult> {
  const result: WriteResult = { accepted: 0, duplicates: 0, rejected: [], stored: new Set() };
  const dirty = new Set<number>();
  const markLate = (ts: number) => {
    if (ctx.now.getTime() - ts > LATE_MS) dirty.add(minute(ts).getTime());
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

  const interactionRows: unknown[][] = [];
  const uniqueRows: unknown[][] = [];
  const commandGuilds: string[] = [];
  const commandTimes: Date[] = [];
  const errorRows: unknown[][] = [];
  const restRows: unknown[][] = [];
  const invalidRows: unknown[][] = [];
  const rateRows: unknown[][] = [];
  const customRows: unknown[][] = [];
  const gaugeRows: unknown[][] = [];
  const shardRows: unknown[][] = [];
  const entitlementRows: unknown[][] = [];
  const subscriptionRows: unknown[][] = [];
  const permissionRows: unknown[][] = [];
  const auditRows: unknown[][] = [];
  const periods = new Set<string>();
  let singleRowEvents = 0;

  // Guild lifecycle must be applied in order, inside the transaction.
  const ordered: Indexed[] = [];

  /**
   * One run's unique-user rows (everyone, the command, the server, plus `extra` scopes) and, unless it was autocomplete,
   * the server's first and last activity.
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
    for (const [scope, key] of scopes) uniqueRows.push([ctx.appId, user.period, day, scope, key, user.bytes]);
    if (guild && activity) {
      commandGuilds.push(guild);
      commandTimes.push(ts);
    }
  };

  /** Who ran a command, encrypted: only when the batch and the app are both in audit mode, within audit retention. */
  const audit = (
    e: Extract<Event, { type: 'interaction' | 'message_command' }>,
    ts: Date,
    kind: number,
    customId: string | undefined,
    ackMs: number | undefined,
  ) => {
    if (!ctx.audit || !e.actor || e.ts < ctx.audit.oldestMs) return;
    const { cipher } = ctx.audit;
    const profile =
      e.actor.username !== undefined || e.actor.avatar !== undefined
        ? cipher.encrypt(JSON.stringify({ username: e.actor.username, avatar: e.actor.avatar }))
        : null;
    auditRows.push([
      e.id,
      ts,
      ctx.appId,
      cipher.lookupHash(e.actor.userId),
      cipher.encrypt(e.actor.userId),
      profile,
      e.guild ?? null,
      kind,
      e.command ?? null,
      e.sub ?? null,
      customId ?? null,
      OUTCOME[e.outcome],
      ackMs ?? null,
    ]);
  };

  for (const { index, event: e } of items) {
    const ts = new Date(e.ts);
    switch (e.type) {
      case 'interaction': {
        const user = userHash(index, e.user);
        if (!user) continue;
        periods.add(user.period);
        markLate(e.ts);
        interactionRows.push([
          e.id,
          ts,
          ctx.appId,
          ctx.env,
          ctx.release ?? null,
          KIND[e.kind],
          e.command ?? null,
          e.group ?? null,
          e.sub ?? null,
          e.commandId ?? null,
          e.commandScope ? COMMAND_SCOPE[e.commandScope] : null,
          e.options,
          e.optionValues ? JSON.stringify(e.optionValues) : null,
          e.customId ?? null,
          e.componentType ?? null,
          e.sourceCommand ?? null,
          e.context ?? null,
          e.install ? INSTALL[e.install] : null,
          e.guild ?? null,
          e.channelType ?? null,
          e.locale,
          e.guildLocale ?? null,
          e.memberTier ? MEMBER_TIER[e.memberTier] : null,
          user.bytes,
          user.period,
          e.premium,
          OUTCOME[e.outcome],
          e.errorCode ?? null,
          e.errorClass ?? null,
          e.ackMs ?? null,
          e.responseType ?? null,
          e.deferred ?? null,
          e.ephemeral ?? null,
          e.handlerMs ?? null,
          e.shard ?? null,
          e.weight,
        ]);
        const command = e.kind === 'autocomplete' ? undefined : e.command;
        const extra: [string, string][] = [['locale', e.locale]];
        if (e.install) extra.push(['install', e.install]);
        countRun(user, ts, command, e.guild, e.kind !== 'autocomplete', extra);
        audit(e, ts, KIND[e.kind], e.customId, e.ackMs);
        break;
      }
      case 'message_command': {
        const user = userHash(index, e.user);
        if (!user) continue;
        periods.add(user.period);
        markLate(e.ts);
        // Stored with interactions so every command view counts it. A message has no user language, install type,
        // entitlements or response, so those columns hold empty values that the deadline and premium figures skip.
        interactionRows.push([
          e.id,
          ts,
          ctx.appId,
          ctx.env,
          ctx.release ?? null,
          KIND.message_command,
          e.command,
          e.group ?? null,
          e.sub ?? null,
          null,
          null,
          e.options,
          e.optionValues ? JSON.stringify(e.optionValues) : null,
          null,
          null,
          null,
          e.guild ? 0 : 1,
          null,
          e.guild ?? null,
          e.channelType ?? null,
          '',
          e.guildLocale ?? null,
          e.memberTier ? MEMBER_TIER[e.memberTier] : null,
          user.bytes,
          user.period,
          false,
          OUTCOME[e.outcome],
          e.errorCode ?? null,
          e.errorClass ?? null,
          null,
          null,
          null,
          null,
          e.handlerMs ?? null,
          e.shard ?? null,
          e.weight,
        ]);
        countRun(user, ts, e.command, e.guild, true, []);
        audit(e, ts, KIND.message_command, undefined, undefined);
        break;
      }
      case 'interaction_error':
        markLate(e.ts);
        errorRows.push([
          e.id,
          ts,
          ctx.appId,
          e.interaction,
          e.command ?? null,
          e.errorClass,
          e.errorCode ?? null,
          e.handlerMs ?? null,
          e.weight,
        ]);
        break;
      case 'rest_window':
        markLate(e.ts);
        e.rows.forEach((r, i) => {
          restRows.push([e.id, i, ts, ctx.appId, r.method, r.route, r.status, r.count, r.retries, r.latency, e.weight]);
        });
        invalidRows.push([
          e.id,
          ts,
          ctx.appId,
          e.invalid.count401,
          e.invalid.count403,
          e.invalid.count429,
          e.invalid.shared429,
        ]);
        break;
      case 'rate_limit':
        markLate(e.ts);
        rateRows.push([e.id, ts, ctx.appId, e.scope, e.global, e.route, e.method, e.retryAfter]);
        break;
      case 'invalid_request_warning':
        gaugeRows.push([ctx.appId, ts, 'rest.invalid_warning_count', -1, ctx.instance, e.count]);
        singleRowEvents++;
        break;
      case 'gauge_window':
        for (const g of e.gauges) gaugeRows.push([ctx.appId, ts, g.name, g.shard ?? -1, ctx.instance, g.value]);
        singleRowEvents++;
        break;
      case 'custom': {
        const user = userHash(index, e.user);
        if (user === null) continue;
        markLate(e.ts);
        customRows.push([
          e.id,
          ts,
          ctx.appId,
          e.name,
          JSON.stringify(e.props),
          user?.bytes ?? null,
          e.guild ?? null,
          e.weight,
        ]);
        break;
      }
      case 'shard_state':
        shardRows.push([ctx.appId, ts, e.shard, e.state, e.closeCode ?? null, e.replayed ?? null]);
        break;
      case 'entitlement': {
        const user = userHash(index, e.user);
        if (user === null) continue;
        entitlementRows.push([
          ctx.appId,
          ts,
          e.action,
          e.sku,
          e.entitlementType,
          e.owner,
          user?.bytes ?? null,
          e.guild ?? null,
          e.startsAt === null ? null : new Date(e.startsAt),
          e.endsAt === null ? null : new Date(e.endsAt),
          'gateway',
        ]);
        markLate(e.ts);
        break;
      }
      case 'subscription': {
        const user = userHash(index, e.user);
        if (!user) continue;
        subscriptionRows.push([
          e.id,
          ts,
          ctx.appId,
          e.action,
          e.status,
          e.skus,
          user.bytes,
          new Date(e.periodStart),
          new Date(e.periodEnd),
        ]);
        markLate(e.ts);
        break;
      }
      case 'command_permissions':
        permissionRows.push([e.id, ts, ctx.appId, e.guild, e.command, e.overwrites]);
        break;
      default:
        ordered.push({ index, event: e });
    }
  }

  for (const period of periods) await ensureUniquesPartition(tx, period);

  /** Inserts one row per event: a row already there is a retried event. `fresh` collects the new rows' IDs. */
  const counted = async (table: string, cols: readonly string[], rows: unknown[][], fresh?: Set<string>) => {
    const inserted = await insertRows(
      tx,
      table,
      cols,
      rows,
      undefined,
      fresh &&
        ((ids) => {
          for (const id of ids) fresh.add(id);
        }),
    );
    result.accepted += inserted;
    result.duplicates += rows.length - inserted;
  };

  await counted('interactions', INTERACTION_COLUMNS, interactionRows, result.stored);
  await insertRows(tx, 'uniques', ['app_id', 'period', 'day', 'scope', 'scope_key', 'user_hash'], uniqueRows);
  await insertRows(
    tx,
    'audit_log',
    [
      'interaction_id',
      'ts',
      'app_id',
      'actor_lookup',
      'actor_enc',
      'names_enc',
      'guild_id',
      'kind',
      'command',
      'sub',
      'custom_id',
      'outcome',
      'ack_ms',
    ],
    auditRows,
  );
  await counted(
    'interaction_errors',
    ['id', 'ts', 'app_id', 'interaction_id', 'command', 'error_class', 'error_code', 'handler_ms', 'weight'],
    errorRows,
  );
  await insertRows(
    tx,
    'rest_calls',
    ['event_id', 'row_no', 'ts', 'app_id', 'method', 'route', 'status', 'count', 'retries', 'hist', 'weight'],
    restRows,
  );
  await counted('rest_invalid', ['id', 'ts', 'app_id', 'count401', 'count403', 'count429', 'shared429'], invalidRows);
  await counted('rate_limits', ['id', 'ts', 'app_id', 'scope', 'global', 'route', 'method', 'retry_after'], rateRows);
  const freshCustom = ctx.mirror ? new Set<string>() : undefined;
  await counted(
    'custom_events',
    ['id', 'ts', 'app_id', 'name', 'props', 'user_hash', 'guild_id', 'weight'],
    customRows,
    freshCustom,
  );
  // With ClickHouse, only rows PostgreSQL accepted are mirrored, so retried batches are never counted twice there.
  if (freshCustom) {
    result.mirror = {
      interactions: interactionRows
        .filter((r) => result.stored.has((r[AT.id] as string).toLowerCase()))
        .map((r) => ({
          id: r[AT.id] as string,
          ts: r[AT.ts] as Date,
          appId: r[AT.app_id] as string,
          kind: r[AT.kind] as number,
          command: r[AT.command] as string | null,
          sub: r[AT.sub] as string | null,
          outcome: r[AT.outcome] as number,
          context: r[AT.context] as number | null,
          install: r[AT.install] as number | null,
          guildId: r[AT.guild_id] as string | null,
          locale: r[AT.locale] as string,
          tier: r[AT.member_tier] as number | null,
          userHash: r[AT.user_hash] as Buffer,
          ackMs: r[AT.ack_ms] as number | null,
          weight: r[AT.weight] as number,
        })),
      custom: customRows
        .filter((r) => freshCustom.has((r[0] as string).toLowerCase()))
        .map((r) => ({
          id: r[0] as string,
          ts: r[1] as Date,
          appId: r[2] as string,
          name: r[3] as string,
          userHash: (r[5] as Buffer | null) ?? null,
          guildId: (r[6] as string | null) ?? null,
          weight: r[7] as number,
        })),
    };
  }
  await insertRows(tx, 'gauges', GAUGE_COLUMNS, gaugeRows);
  result.accepted += singleRowEvents;
  await counted('shard_events', ['app_id', 'ts', 'shard', 'state', 'close_code', 'replayed'], shardRows);
  await counted('entitlements', ENTITLEMENT_COLUMNS, entitlementRows);
  await counted(
    'subscriptions',
    ['id', 'ts', 'app_id', 'action', 'status', 'sku_ids', 'user_hash', 'period_start', 'period_end'],
    subscriptionRows,
  );
  await counted('command_permissions', ['id', 'ts', 'app_id', 'guild_id', 'command_id', 'overwrites'], permissionRows);

  for (const { event: e } of ordered) {
    const ts = new Date(e.ts);
    switch (e.type) {
      case 'guild_join':
        if (await applyGuildJoin(tx, ctx.appId, ts, e.info, e.detectedAtStartup)) result.accepted++;
        else result.duplicates++;
        markLate(e.ts);
        break;
      case 'guild_update':
        await applyGuildUpdate(tx, ctx.appId, e.info);
        result.accepted++;
        break;
      case 'guild_leave':
        if (await applyGuildLeave(tx, ctx.appId, ts, e.guild, e.detectedAtStartup)) result.accepted++;
        else result.duplicates++;
        markLate(e.ts);
        break;
      case 'guild_availability': {
        const kind = e.available ? GUILD_EVENT.available : GUILD_EVENT.unavailable;
        if (await recordGuildEvent(tx, ctx.appId, e.guild, ts, kind, false)) result.accepted++;
        else result.duplicates++;
        markLate(e.ts);
        break;
      }
      case 'guild_snapshot':
        await applySnapshot(tx, ctx.appId, ts, e);
        result.accepted++;
        break;
      case 'command_registry':
        await applyRegistry(tx, ctx.appId, e.commands);
        result.accepted++;
        break;
      case 'app_info':
        await applyAppInfo(tx, ctx, e);
        result.accepted++;
        break;
      case 'sdk_health':
        await tx.query(
          `INSERT INTO sdk_health (app_id, instance, ts, shards, queue_depth, dropped, failed_flushes, internal_errors, sdk_version)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (app_id, instance) DO UPDATE SET ts = EXCLUDED.ts, shards = EXCLUDED.shards,
             queue_depth = EXCLUDED.queue_depth, dropped = EXCLUDED.dropped, failed_flushes = EXCLUDED.failed_flushes,
             internal_errors = EXCLUDED.internal_errors, sdk_version = EXCLUDED.sdk_version
           WHERE sdk_health.ts <= EXCLUDED.ts`,
          [
            ctx.appId,
            ctx.instance,
            ts,
            ctx.shards,
            e.queueDepth,
            JSON.stringify(e.dropped),
            e.failedFlushes,
            JSON.stringify(e.internalErrors),
            ctx.sdkVersion,
          ],
        );
        result.accepted++;
        break;
      default:
        break;
    }
  }

  if (commandTimes.length > 0) {
    // By time, as a batch isn't in event order: commands before a removal in the same batch count, later ones are a
    // user install used in a server the bot has left.
    await tx.query(
      `UPDATE guilds g SET
         first_command_at = LEAST(coalesce(g.first_command_at, v.first), v.first),
         last_command_at = GREATEST(coalesce(g.last_command_at, v.last), v.last)
       FROM (SELECT c.guild_id, min(c.ts) AS first, max(c.ts) AS last
               FROM unnest($2::bigint[], $3::timestamptz[]) AS c(guild_id, ts)
               JOIN guilds k ON k.app_id = $1 AND k.guild_id = c.guild_id
              WHERE k.left_at IS NULL OR c.ts <= k.left_at
              GROUP BY c.guild_id) v
       WHERE g.app_id = $1 AND g.guild_id = v.guild_id`,
      [ctx.appId, commandGuilds, commandTimes],
    );
  }

  if (dirty.size > 0) {
    await insertRows(
      tx,
      'dirty_buckets',
      ['app_id', 'bucket'],
      [...dirty].map((b) => [ctx.appId, new Date(b)]),
    );
  }

  return result;
}

async function applyRegistry(
  tx: Tx,
  appId: string,
  listed: { id: string; name: string; type: number; guild?: string | undefined; subcommands: string[] }[],
) {
  // One statement can't update a row twice, so a command listed twice (last one wins) would fail the batch.
  const commands = [...new Map(listed.map((c) => [c.id, c])).values()];
  await insertRows(
    tx,
    'command_registry',
    ['app_id', 'command_id', 'name', 'type', 'guild_id', 'subcommands'],
    commands.map((c) => [appId, c.id, c.name, c.type, c.guild ?? null, c.subcommands]),
    `ON CONFLICT (app_id, command_id) DO UPDATE SET name = EXCLUDED.name, type = EXCLUDED.type,
       subcommands = EXCLUDED.subcommands, last_seen = now()`,
  );
  // The registry lists global commands; drop global ones that were unregistered.
  await tx.query(
    'DELETE FROM command_registry WHERE app_id = $1 AND guild_id IS NULL AND NOT (command_id = ANY($2::bigint[]))',
    [appId, commands.filter((c) => !c.guild).map((c) => c.id)],
  );
}

async function applyAppInfo(tx: Tx, ctx: IngestContext, e: Extract<Event, { type: 'app_info' }>) {
  const ts = new Date(e.ts);
  const newest = await tx.query(
    `INSERT INTO app_info (app_id, ts, name, approx_guilds, approx_user_installs, approx_user_auths, dashboard_user_ids,
       event_webhooks_status, skus, session_start_remaining, session_start_total, node_version, lib_version,
       sdk_version, release)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (app_id) DO UPDATE SET ts = EXCLUDED.ts, name = EXCLUDED.name, approx_guilds = EXCLUDED.approx_guilds,
       approx_user_installs = EXCLUDED.approx_user_installs, approx_user_auths = EXCLUDED.approx_user_auths,
       dashboard_user_ids = EXCLUDED.dashboard_user_ids, event_webhooks_status = EXCLUDED.event_webhooks_status,
       skus = EXCLUDED.skus, session_start_remaining = EXCLUDED.session_start_remaining,
       session_start_total = EXCLUDED.session_start_total, node_version = EXCLUDED.node_version,
       lib_version = EXCLUDED.lib_version, sdk_version = EXCLUDED.sdk_version, release = EXCLUDED.release
     WHERE app_info.ts <= EXCLUDED.ts
     RETURNING app_id`,
    [
      ctx.appId,
      ts,
      e.name,
      e.approximateGuildCount,
      e.approximateUserInstallCount,
      e.approximateUserAuthorizationCount,
      e.dashboardUserIds,
      e.eventWebhooksStatus,
      JSON.stringify(e.skus),
      e.sessionStartRemaining ?? null,
      e.sessionStartTotal ?? null,
      e.nodeVersion,
      e.libVersion,
      ctx.sdkVersion,
      ctx.release ?? null,
    ],
  );
  // A report older than the stored one (a late retry) must not bring back an old name.
  if (newest.rowCount) await tx.query('UPDATE apps SET name = $2 WHERE app_id = $1', [ctx.appId, e.name]);
  const gauges: [string, number | null | undefined][] = [
    ['app.approx_guilds', e.approximateGuildCount],
    ['app.approx_user_installs', e.approximateUserInstallCount],
    ['identify.remaining', e.sessionStartRemaining],
  ];
  await insertRows(
    tx,
    'gauges',
    GAUGE_COLUMNS,
    gauges.filter(([, v]) => typeof v === 'number').map(([name, v]) => [ctx.appId, ts, name, -1, ctx.instance, v]),
  );
}
