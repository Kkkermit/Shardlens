import type { Event } from '@shardlens/schema';
import { insertRows, type Tx } from '../db.js';
import type { auditCipher } from '../security/crypto.js';
import type { MirroredCustom, MirroredInteraction } from '../storage/clickhouse.js';
import { ensureUniquesPartition } from '../storage/maintenance.js';
import { COMMAND_SCOPE, INSTALL, KIND, MEMBER_TIER, OUTCOME, parseUserHash } from './codes.js';
import { applyGuildJoin, applyGuildLeave, applyGuildUpdate, applySnapshot } from './guilds.js';

export interface IngestContext {
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

export interface WriteResult {
  accepted: number;
  duplicates: number;
  rejected: { index: number; reason: string }[];
  interactions: number;
  errors: number;
  /** Rows PostgreSQL accepted (never retries), when `ctx.mirror` is set. */
  mirror?: { interactions: MirroredInteraction[]; custom: MirroredCustom[] } | undefined;
}

/** Minutes older than this when they arrive are marked dirty so the rollup job recomputes them. */
const LATE_MS = 2 * 60_000;

const minute = (ts: number) => new Date(Math.floor(ts / 60_000) * 60_000);

/**
 * Writes one validated batch in the caller's transaction. Every insert is idempotent (`ON CONFLICT DO NOTHING` on the
 * UUIDv7 event ID), so a retried batch is counted once.
 */
export async function writeEvents(tx: Tx, ctx: IngestContext, items: readonly Indexed[]): Promise<WriteResult> {
  const result: WriteResult = { accepted: 0, duplicates: 0, rejected: [], interactions: 0, errors: 0 };
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
  const commandTimes = new Map<string, { first: number; last: number }>();
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
        const day = ts.toISOString().slice(0, 10);
        const scopes: [string, string][] = [['global', '*']];
        if (e.command && e.kind !== 'autocomplete') scopes.push(['command', e.command]);
        if (e.guild) scopes.push(['guild', e.guild]);
        scopes.push(['locale', e.locale]);
        if (e.install) scopes.push(['install', e.install]);
        for (const [scope, key] of scopes) uniqueRows.push([ctx.appId, user.period, day, scope, key, user.bytes]);
        if (e.guild && e.kind !== 'autocomplete') {
          const t = commandTimes.get(e.guild);
          commandTimes.set(e.guild, { first: Math.min(t?.first ?? e.ts, e.ts), last: Math.max(t?.last ?? e.ts, e.ts) });
        }
        if (ctx.audit && e.actor && e.ts >= ctx.audit.oldestMs) {
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
            KIND[e.kind],
            e.command ?? null,
            e.sub ?? null,
            e.customId ?? null,
            OUTCOME[e.outcome],
            e.ackMs ?? null,
          ]);
        }
        result.interactions += e.weight;
        if (e.outcome !== 'ok') result.errors += e.weight;
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
        singleRowEvents++;
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
        singleRowEvents++;
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
        singleRowEvents++;
        break;
      }
      case 'command_permissions':
        permissionRows.push([e.id, ts, ctx.appId, e.guild, e.command, e.overwrites]);
        singleRowEvents++;
        break;
      default:
        ordered.push({ index, event: e });
    }
  }

  for (const period of periods) await ensureUniquesPartition(tx, period);

  const interactionCols = [
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
  ];
  const counted = async (table: string, cols: string[], rows: unknown[][], fresh?: Set<string>) => {
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

  // With ClickHouse, only rows PostgreSQL accepted are mirrored, so retried batches are never counted twice there.
  const freshInteractions = ctx.mirror ? new Set<string>() : undefined;
  await counted('interactions', interactionCols, interactionRows, freshInteractions);
  if (freshInteractions) {
    result.mirror = {
      interactions: interactionRows
        .filter((r) => freshInteractions.has(r[0] as string))
        .map((r) => ({
          id: r[0] as string,
          ts: r[1] as Date,
          appId: r[2] as string,
          kind: r[5] as number,
          command: r[6] as string | null,
          sub: r[8] as string | null,
          outcome: r[26] as number,
          context: r[16] as number | null,
          install: r[17] as number | null,
          guildId: r[18] as string | null,
          locale: r[20] as string,
          tier: r[22] as number | null,
          userHash: r[23] as Buffer,
          ackMs: r[29] as number | null,
          weight: r[35] as number,
        })),
      custom: [],
    };
  }
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
  const freshCustom = result.mirror ? new Set<string>() : undefined;
  await counted(
    'custom_events',
    ['id', 'ts', 'app_id', 'name', 'props', 'user_hash', 'guild_id', 'weight'],
    customRows,
    freshCustom,
  );
  if (result.mirror && freshCustom) {
    result.mirror.custom = customRows
      .filter((r) => freshCustom.has(r[0] as string))
      .map((r) => ({
        id: r[0] as string,
        ts: r[1] as Date,
        appId: r[2] as string,
        name: r[3] as string,
        userHash: (r[5] as Buffer | null) ?? null,
        guildId: (r[6] as string | null) ?? null,
        weight: r[7] as number,
      }));
  }
  await insertRows(tx, 'gauges', ['app_id', 'ts', 'name', 'shard', 'instance', 'value'], gaugeRows);
  await insertRows(tx, 'shard_events', ['app_id', 'ts', 'shard', 'state', 'close_code', 'replayed'], shardRows);
  await insertRows(
    tx,
    'entitlements',
    [
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
    ],
    entitlementRows,
  );
  await insertRows(
    tx,
    'subscriptions',
    ['id', 'ts', 'app_id', 'action', 'status', 'sku_ids', 'user_hash', 'period_start', 'period_end'],
    subscriptionRows,
  );
  await insertRows(
    tx,
    'command_permissions',
    ['id', 'ts', 'app_id', 'guild_id', 'command_id', 'overwrites'],
    permissionRows,
  );
  result.accepted += singleRowEvents;

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
      case 'guild_availability':
        await insertRows(
          tx,
          'guild_events',
          ['app_id', 'guild_id', 'ts', 'kind', 'detected_at_startup'],
          [[ctx.appId, e.guild, ts, e.available ? 4 : 3, false]],
        );
        result.accepted++;
        break;
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

  if (commandTimes.size > 0) {
    const ids = [...commandTimes.keys()];
    await tx.query(
      `UPDATE guilds g SET
         first_command_at = LEAST(coalesce(g.first_command_at, v.first), v.first),
         last_command_at = GREATEST(coalesce(g.last_command_at, v.last), v.last)
       FROM unnest($2::bigint[], $3::timestamptz[], $4::timestamptz[]) AS v(guild_id, first, last)
       WHERE g.app_id = $1 AND g.guild_id = v.guild_id AND g.left_at IS NULL`,
      [
        ctx.appId,
        ids,
        ids.map((id) => new Date(commandTimes.get(id)!.first)),
        ids.map((id) => new Date(commandTimes.get(id)!.last)),
      ],
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
  commands: { id: string; name: string; type: number; guild?: string | undefined; subcommands: string[] }[],
) {
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
  await tx.query(
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
     WHERE app_info.ts <= EXCLUDED.ts`,
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
  await tx.query('UPDATE apps SET name = $2 WHERE app_id = $1', [ctx.appId, e.name]);
  const gauges: [string, number | null | undefined][] = [
    ['app.approx_guilds', e.approximateGuildCount],
    ['app.approx_user_installs', e.approximateUserInstallCount],
    ['identify.remaining', e.sessionStartRemaining],
  ];
  await insertRows(
    tx,
    'gauges',
    ['app_id', 'ts', 'name', 'shard', 'instance', 'value'],
    gauges.filter(([, v]) => typeof v === 'number').map(([name, v]) => [ctx.appId, ts, name, -1, ctx.instance, v]),
  );
}
