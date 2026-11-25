import { createHash } from 'node:crypto';
import { Binary, type Collection, type Db, type IndexDescription, type ObjectId, type UUID } from 'mongodb';
import type { ApiKeyScope } from '../../security/keys.js';
import type { SaltPeriod } from '../periods.js';
import type { AppMode, SessionMethod } from '../store.js';

/*
 * The collections MongoStore keeps in the owner's database, one per PostgreSQL table (`migrations/`), prefixed so they
 * sit beside the bot's own. Fields are the columns in camelCase. Conventions every area follows:
 *
 * - Discord IDs (apps, servers, commands, SKUs, users in `dashboardUserIds`) are decimal strings.
 * - Salted user hashes, sealed values and SHA-256 digests are `Binary`. The driver reads them back as `Binary`, never
 *   `Buffer`: `Buffer.from(b.buffer)` turns one back.
 * - A single event's `_id` is its UUIDv7 as a BSON UUID, so a retried batch is a duplicate-key no-op.
 * - A column that is NULL is left out of the document, and reads treat a missing field as NULL.
 * - Codes (`kind`, `outcome`, `install`, ...) are the numbers in `ingest/codes.ts`, as in PostgreSQL.
 * - Log rows nothing refers to by ID (access log, admin audit, alert firings) take an ObjectId: no sequence to bump, and
 *   it breaks ties between rows of the same millisecond in the order they were written.
 * - Nothing needs a transaction or a change stream: MongoStore runs on a standalone server as well as a replica set or
 *   Atlas. Where PostgreSQL relies on a transaction, the MongoDB write is idempotent instead, so a retry completes it.
 */

export interface AppDoc {
  _id: string;
  name: string;
  mode: AppMode;
  saltPeriod: SaltPeriod;
  timezone: string;
  rawRetentionDays: number;
  shardCount?: number;
  baselineDone: boolean;
  createdAt: Date;
}

export interface ApiKeyDoc {
  /** Decimal, from `nextId('api_keys')`: routes take IDs of up to 18 digits. */
  _id: string;
  appId: string;
  scope: ApiKeyScope;
  sha256: Binary;
  label?: string;
  createdAt: Date;
  lastUsedAt?: Date;
  revokedAt?: Date;
}

export interface SaltDoc {
  _id: { appId: string; period: string };
  /** Removed when the salt is destroyed. */
  secret?: Binary;
  periodEnd: Date;
  destroyAfter: Date;
  destroyedAt?: Date;
}

/** Shared by every single-event collection. */
interface EventBase {
  _id: UUID;
  ts: Date;
  appId: string;
}

export interface InteractionDoc extends EventBase {
  env: string;
  release?: string;
  kind: number;
  command?: string;
  cmdGroup?: string;
  sub?: string;
  commandId?: string;
  commandScope?: number;
  options: string[];
  optionValues?: Record<string, unknown>;
  customId?: string;
  componentType?: number;
  sourceCommand?: string;
  context?: number;
  install?: number;
  guildId?: string;
  channelType?: number;
  locale: string;
  guildLocale?: string;
  memberTier?: number;
  userHash: Binary;
  saltPeriod: string;
  premium: boolean;
  outcome: number;
  errorCode?: number;
  errorClass?: string;
  ackMs?: number;
  responseType?: number;
  deferred?: boolean;
  ephemeral?: boolean;
  handlerMs?: number;
  shard?: number;
  weight: number;
}

export interface InteractionErrorDoc extends EventBase {
  interactionId: UUID;
  command?: string;
  errorClass: string;
  errorCode?: number;
  handlerMs?: number;
  weight: number;
}

/** One row of a `rest` event: PostgreSQL keys it by (event ID, row number). */
export interface RestCallDoc {
  _id: { eventId: UUID; row: number };
  ts: Date;
  appId: string;
  method: string;
  route: string;
  status: number;
  count: number;
  retries: number;
  hist: number[];
  weight: number;
}

export interface RestInvalidDoc extends EventBase {
  count401: number;
  count403: number;
  count429: number;
  shared429: number;
}

export interface RateLimitDoc extends EventBase {
  scope: string;
  global: boolean;
  route: string;
  method: string;
  retryAfter: number;
}

export interface CustomEventDoc extends EventBase {
  name: string;
  props: Record<string, unknown>;
  userHash?: Binary;
  guildId?: string;
  weight: number;
}

export interface WebhookEventDoc extends EventBase {
  type: string;
  integrationType?: number;
  userHash?: Binary;
  /** Audit mode only: the installing user, encrypted. */
  actorEnc?: Binary;
  guildId?: string;
  scopes?: string[];
}

export interface GaugeDoc {
  _id: { appId: string; name: string; shard: number; instance: string; ts: Date };
  value: number;
}

export interface AuditLogDoc {
  /** The interaction's ID. */
  _id: UUID;
  ts: Date;
  appId: string;
  actorLookup: Binary;
  actorEnc: Binary;
  namesEnc?: Binary;
  guildId?: string;
  kind: number;
  command?: string;
  sub?: string;
  customId?: string;
  outcome: number;
  ackMs?: number;
}

export interface AccessLogDoc {
  _id: ObjectId;
  ts: Date;
  appId: string;
  viewerUserId: string;
  viewerKeyId?: string;
  action: string;
  details: object;
}

export interface GuildDoc {
  _id: { appId: string; guildId: string };
  name: string;
  icon?: string;
  memberCount: number;
  sizeAtJoin?: number;
  large?: boolean;
  preferredLocale?: string;
  features: string[];
  premiumTier?: number;
  boosts?: number;
  verificationLevel?: number;
  nsfwLevel?: number;
  mfaLevel?: number;
  createdAt?: Date;
  joinedAt: Date;
  leftAt?: Date;
  shard?: number;
  channelCounts?: Record<string, number>;
  roleCount?: number;
  emojiCount?: number;
  stickerCount?: number;
  /** Permission bits, decimal. */
  botPermissions?: string;
  detectedAtStartup: boolean;
  baseline: boolean;
  firstCommandAt?: Date;
  lastCommandAt?: Date;
  updatedAt: Date;
}

export interface GuildEventDoc {
  _id: { appId: string; guildId: string; ts: Date; kind: number };
  detectedAtStartup: boolean;
}

export interface SnapshotPendingDoc {
  _id: { appId: string; shardCount: number; shard: number };
  guilds: string[];
  ts: Date;
}

export interface CommandRegistryDoc {
  _id: { appId: string; commandId: string };
  name: string;
  type: number;
  guildId?: string;
  subcommands: string[];
  firstSeen: Date;
  lastSeen: Date;
}

export interface CommandPermissionDoc extends EventBase {
  guildId: string;
  commandId: string;
  overwrites: number;
}

export interface UniqueDoc {
  _id: { appId: string; period: string; scope: string; scopeKey: string; day: string; userHash: Binary };
}

export interface UniqueCountDoc {
  /** `startDay` is `YYYY-MM-DD`. */
  _id: { appId: string; grain: 'day' | 'week' | 'month'; startDay: string; scope: string; scopeKey: string };
  users: number;
  newUsers: number;
  final: boolean;
}

/** `rollup_1m`, `rollup_1h` and `rollup_1d`: the same shape, a bucket of a minute, an hour or a UTC day. */
export interface RollupDoc {
  /** {@link rollupId}: one document per app, metric, bucket and dimensions, so a recompute replaces it. */
  _id: Binary;
  appId: string;
  metric: string;
  bucket: Date;
  dims: Record<string, string | number | boolean | null>;
  /** {@link dimsKey} of `dims`, to group by dimensions without comparing documents field by field. */
  dimsKey: string;
  count: number;
  sum: number;
  min?: number;
  max?: number;
  /** 40 buckets, as `@shardlens/core`'s `bucketOf`. */
  hist?: number[];
}

export interface DirtyBucketDoc {
  _id: { appId: string; bucket: Date };
}

export interface ShardEventDoc {
  _id: { appId: string; shard: number; ts: Date; state: string };
  closeCode?: number;
  replayed?: number;
}

export interface EntitlementDoc {
  /** PostgreSQL's unique key (app, time, SKU, action, user, server), NULLs equal. */
  _id: Binary;
  appId: string;
  ts: Date;
  action: string;
  skuId: string;
  entitlementType: number;
  owner: string;
  userHash?: Binary;
  guildId?: string;
  startsAt?: Date;
  endsAt?: Date;
  source: 'gateway' | 'webhook';
}

export interface SubscriptionDoc extends EventBase {
  action: string;
  status: number;
  skuIds: string[];
  userHash: Binary;
  periodStart: Date;
  periodEnd: Date;
}

export interface AppInfoDoc {
  _id: string;
  ts: Date;
  name: string;
  approxGuilds?: number;
  approxUserInstalls?: number;
  approxUserAuths?: number;
  dashboardUserIds: string[];
  eventWebhooksStatus?: number;
  skus: unknown[];
  sessionStartRemaining?: number;
  sessionStartTotal?: number;
  nodeVersion?: string;
  libVersion?: string;
  sdkVersion?: string;
  release?: string;
}

export interface SdkHealthDoc {
  _id: { appId: string; instance: string };
  ts: Date;
  shards: number[];
  queueDepth: number;
  dropped: Record<string, number>;
  failedFlushes: number;
  internalErrors: Record<string, number>;
  sdkVersion?: string;
}

export interface SettingDoc {
  _id: { appId: string; key: string };
  value: unknown;
}

export interface AlertRuleDoc {
  _id: string;
  appId: string;
  name: string;
  metric: string;
  comparator: '>' | '>=' | '<' | '<=';
  threshold: number;
  windowS: number;
  webhookEnc: Binary;
  enabled: boolean;
  lastFired?: Date;
}

export interface AlertEventDoc {
  _id: ObjectId;
  ruleId: string;
  appId: string;
  ts: Date;
  value: number;
  delivered: boolean;
  error?: string;
}

export interface ReportDoc {
  _id: string;
  appId: string;
  name: string;
  schedule: 'daily' | 'weekly';
  hour: number;
  weekday: number;
  webhookEnc: Binary;
  enabled: boolean;
  lastSent?: Date;
  lastError?: string;
}

export interface SessionDoc {
  _id: Binary;
  userId?: string;
  appId: string;
  method: SessionMethod;
  keyId?: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface AdminAuditDoc {
  _id: ObjectId;
  ts: Date;
  appId: string;
  userId?: string;
  action: string;
  details: object;
}

/** Sequences for the decimal IDs of keys, rules and reports ({@link nextId}). */
export interface CounterDoc {
  _id: string;
  n: number;
}

/** Leases: the job leader's (`jobs`), renewed while it leads. */
export interface LeaseDoc {
  _id: string;
  holder: string;
  expiresAt: Date;
}

/**
 * Live tile counts shared between collector instances, read by polling (no change streams). Kept for the 15 minutes the
 * tiles show, so an instance whose dashboard opens reads them back.
 */
export interface LiveShareDoc {
  _id: string;
  instance: string;
  appId: string;
  counts: [number, number, number][];
  /** The server's time when it was written, so readers and the TTL index go by one clock. */
  at: Date;
}

/** An instance with a live stream open, so the others know to publish their counts (`live.ts`). */
export interface LiveListenerDoc {
  _id: string;
  /** Renewed while the stream is open; the server's time. */
  at: Date;
}

/** Collector secrets generated on first start, for the in-bot and `npx shardlens dashboard` runners. */
export interface SecretDoc {
  _id: string;
  value: string;
}

export interface Collections {
  apps: Collection<AppDoc>;
  apiKeys: Collection<ApiKeyDoc>;
  salts: Collection<SaltDoc>;
  interactions: Collection<InteractionDoc>;
  interactionErrors: Collection<InteractionErrorDoc>;
  restCalls: Collection<RestCallDoc>;
  restInvalid: Collection<RestInvalidDoc>;
  rateLimits: Collection<RateLimitDoc>;
  customEvents: Collection<CustomEventDoc>;
  webhookEvents: Collection<WebhookEventDoc>;
  gauges: Collection<GaugeDoc>;
  auditLog: Collection<AuditLogDoc>;
  accessLog: Collection<AccessLogDoc>;
  guilds: Collection<GuildDoc>;
  guildEvents: Collection<GuildEventDoc>;
  snapshotPending: Collection<SnapshotPendingDoc>;
  commandRegistry: Collection<CommandRegistryDoc>;
  commandPermissions: Collection<CommandPermissionDoc>;
  uniques: Collection<UniqueDoc>;
  uniqueCounts: Collection<UniqueCountDoc>;
  rollup1m: Collection<RollupDoc>;
  rollup1h: Collection<RollupDoc>;
  rollup1d: Collection<RollupDoc>;
  dirtyBuckets: Collection<DirtyBucketDoc>;
  shardEvents: Collection<ShardEventDoc>;
  entitlements: Collection<EntitlementDoc>;
  subscriptions: Collection<SubscriptionDoc>;
  appInfo: Collection<AppInfoDoc>;
  sdkHealth: Collection<SdkHealthDoc>;
  settings: Collection<SettingDoc>;
  alertRules: Collection<AlertRuleDoc>;
  alertEvents: Collection<AlertEventDoc>;
  reports: Collection<ReportDoc>;
  sessions: Collection<SessionDoc>;
  adminAudit: Collection<AdminAuditDoc>;
  counters: Collection<CounterDoc>;
  leases: Collection<LeaseDoc>;
  liveShares: Collection<LiveShareDoc>;
  liveListeners: Collection<LiveListenerDoc>;
  secrets: Collection<SecretDoc>;
}

/** Collection names in the database, and the indexes each keeps besides `_id`. */
const LAYOUT: { [K in keyof Collections]: { name: string; indexes: IndexDescription[] } } = {
  apps: { name: 'shardlens_apps', indexes: [] },
  apiKeys: {
    name: 'shardlens_api_keys',
    indexes: [{ key: { sha256: 1 }, unique: true }, { key: { appId: 1 } }],
  },
  salts: { name: 'shardlens_salts', indexes: [{ key: { destroyAfter: 1 } }] },
  interactions: {
    name: 'shardlens_interactions',
    indexes: [
      { key: { appId: 1, ts: 1 } },
      { key: { appId: 1, command: 1, ts: 1 } },
      { key: { appId: 1, guildId: 1, ts: 1 } },
      { key: { appId: 1, userHash: 1 } },
    ],
  },
  interactionErrors: { name: 'shardlens_interaction_errors', indexes: [{ key: { appId: 1, ts: 1 } }] },
  restCalls: { name: 'shardlens_rest_calls', indexes: [{ key: { appId: 1, ts: 1 } }] },
  restInvalid: { name: 'shardlens_rest_invalid', indexes: [{ key: { appId: 1, ts: 1 } }] },
  rateLimits: { name: 'shardlens_rate_limits', indexes: [{ key: { appId: 1, ts: 1 } }] },
  customEvents: {
    name: 'shardlens_custom_events',
    indexes: [{ key: { appId: 1, name: 1, ts: 1 } }, { key: { appId: 1, userHash: 1 }, sparse: true }],
  },
  webhookEvents: {
    name: 'shardlens_webhook_events',
    indexes: [{ key: { appId: 1, ts: 1 } }, { key: { appId: 1, userHash: 1 }, sparse: true }],
  },
  gauges: { name: 'shardlens_gauges', indexes: [{ key: { '_id.appId': 1, '_id.name': 1, '_id.ts': 1 } }] },
  auditLog: {
    name: 'shardlens_audit_log',
    // The activity log reads newest first by time and then `_id`: with `_id` in the index, a page is read from it in
    // order instead of sorting every row that matches. Failures are a small share of the log, so the two indexes that
    // hold only failures stay small (PostgreSQL's `WHERE outcome <> 0`; outcomes are 0 to 3).
    indexes: [
      { key: { appId: 1, ts: -1, _id: -1 } },
      { key: { appId: 1, actorLookup: 1, ts: -1, _id: -1 } },
      { key: { appId: 1, guildId: 1, ts: -1, _id: -1 } },
      {
        key: { appId: 1, ts: -1, _id: -1 },
        name: 'failed_appId_ts_id',
        partialFilterExpression: { outcome: { $gt: 0 } },
      },
      {
        key: { appId: 1, guildId: 1, ts: -1, _id: -1 },
        name: 'failed_appId_guildId_ts_id',
        partialFilterExpression: { outcome: { $gt: 0 } },
      },
    ],
  },
  accessLog: { name: 'shardlens_audit_access_log', indexes: [{ key: { appId: 1, ts: -1, _id: -1 } }] },
  guilds: { name: 'shardlens_guilds', indexes: [{ key: { '_id.appId': 1, leftAt: 1 } }] },
  guildEvents: { name: 'shardlens_guild_events', indexes: [{ key: { '_id.appId': 1, '_id.ts': 1 } }] },
  snapshotPending: { name: 'shardlens_snapshot_pending', indexes: [] },
  commandRegistry: { name: 'shardlens_command_registry', indexes: [] },
  commandPermissions: { name: 'shardlens_command_permissions', indexes: [{ key: { appId: 1, ts: 1 } }] },
  uniques: { name: 'shardlens_uniques', indexes: [{ key: { '_id.appId': 1, '_id.userHash': 1 } }] },
  uniqueCounts: { name: 'shardlens_unique_counts', indexes: [] },
  rollup1m: { name: 'shardlens_rollup_1m', indexes: [{ key: { appId: 1, metric: 1, bucket: 1 } }] },
  rollup1h: { name: 'shardlens_rollup_1h', indexes: [{ key: { appId: 1, metric: 1, bucket: 1 } }] },
  rollup1d: { name: 'shardlens_rollup_1d', indexes: [{ key: { appId: 1, metric: 1, bucket: 1 } }] },
  dirtyBuckets: { name: 'shardlens_dirty_buckets', indexes: [] },
  shardEvents: { name: 'shardlens_shard_events', indexes: [{ key: { '_id.appId': 1, '_id.ts': 1 } }] },
  entitlements: { name: 'shardlens_entitlements', indexes: [{ key: { appId: 1, ts: 1 } }] },
  subscriptions: { name: 'shardlens_subscriptions', indexes: [{ key: { appId: 1, ts: 1 } }] },
  appInfo: { name: 'shardlens_app_info', indexes: [] },
  sdkHealth: { name: 'shardlens_sdk_health', indexes: [] },
  settings: { name: 'shardlens_settings', indexes: [] },
  alertRules: { name: 'shardlens_alert_rules', indexes: [{ key: { appId: 1 } }] },
  alertEvents: {
    name: 'shardlens_alert_events',
    indexes: [{ key: { appId: 1, ts: -1, _id: -1 } }, { key: { ruleId: 1 } }],
  },
  reports: { name: 'shardlens_reports', indexes: [{ key: { appId: 1 } }] },
  sessions: {
    name: 'shardlens_sessions',
    // Expired sessions go by themselves, as the retention job deletes them on PostgreSQL.
    indexes: [
      { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
      { key: { keyId: 1 }, sparse: true },
    ],
  },
  adminAudit: { name: 'shardlens_admin_audit', indexes: [{ key: { appId: 1, ts: -1 } }] },
  counters: { name: 'shardlens_counters', indexes: [] },
  leases: { name: 'shardlens_leases', indexes: [] },
  liveShares: { name: 'shardlens_live', indexes: [{ key: { at: 1 }, expireAfterSeconds: 16 * 60 }] },
  liveListeners: { name: 'shardlens_live_listeners', indexes: [{ key: { at: 1 }, expireAfterSeconds: 120 }] },
  secrets: { name: 'shardlens_secrets', indexes: [] },
};

export function collections(db: Db): Collections {
  return Object.fromEntries(
    Object.entries(LAYOUT).map(([key, { name }]) => [key, db.collection(name)]),
  ) as unknown as Collections;
}

/** Creates every collection's indexes. Safe to run at every start, and from several processes at once. */
export async function ensureIndexes(db: Db): Promise<void> {
  await Promise.all(
    Object.values(LAYOUT).map(({ name, indexes }) =>
      indexes.length === 0 ? undefined : db.collection(name).createIndexes(indexes),
    ),
  );
}

/** Dimensions as one string, keys sorted, so equal dimensions give equal keys whatever order they were built in. */
export function dimsKey(dims: RollupDoc['dims']): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.keys(dims)
        .sort()
        .map((k) => [k, dims[k]]),
    ),
  );
}

/** `_id` of a rollup document: SHA-256 of its app, metric, bucket and {@link dimsKey}. */
export function rollupId(appId: string, metric: string, bucket: Date, key: string): Binary {
  return new Binary(createHash('sha256').update(`${appId}\0${metric}\0${bucket.getTime()}\0${key}`).digest());
}
