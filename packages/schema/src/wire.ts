/**
 * Shardlens wire format v1 (zod 4).
 *
 * The SDK sends gzipped JSON batches matching {@link Batch}. The collector validates them with these schemas.
 * Within a major version, changes are additive only: never remove a field, never narrow a type.
 *
 * Unknown keys are stripped rather than rejected, so a newer SDK can talk to an older collector of the same major.
 */
import { z } from 'zod';

export const WIRE_VERSION = 1;

/**
 * Discord snowflake as a decimal string (snowflakes overflow JavaScript numbers). Capped just below 2^63, the largest
 * value the collector's `bigint` columns hold; real IDs stay under it until about 2084.
 */
export const Snowflake = z.string().regex(/^(?:\d{17,18}|[1-8]\d{18}|9[01]\d{17})$/);

/**
 * Pseudonymised user: `h1:<salt period>:<32 hex>`, where the hex is the first 16 bytes of
 * HMAC-SHA-256(period salt, user ID). Raw snowflakes are rejected here on purpose.
 */
export const UserHash = z.string().regex(/^h1:(\d{4}-\d{2}(-\d{2})?|\d{4}-W\d{2}):[0-9a-f]{32}$/);

/** Epoch milliseconds. */
export const Ts = z.number().int().positive();

/** RFC 9562 UUIDv7: time-ordered, so the collector can de-duplicate within one partition. */
export const Id = z.uuid({ version: 'v7' });

const Base = z.object({
  id: Id,
  ts: Ts,
  /** Inverse sample rate: an event kept at a 10% sample rate carries `weight: 10`. */
  weight: z.number().positive().max(10_000).default(1),
});

/**
 * Who ran an interaction: a user ID, a username and an avatar, and nothing else. Present only when the SDK runs in
 * audit mode. Never sent in privacy mode.
 */
export const Actor = z.object({
  userId: Snowflake,
  username: z.string().max(64).optional(),
  /** Discord's avatar hash, from which the profile picture's CDN address is built. */
  avatar: z
    .string()
    .regex(/^(a_)?[0-9a-f]{32}$/)
    .optional(),
});

export const InteractionKind = z.enum([
  'chat_input',
  'user_context',
  'message_context',
  'primary_entry_point',
  'button',
  'select',
  'modal_submit',
  'autocomplete',
]);

export const InteractionOutcome = z.enum(['ok', 'error', 'timeout', 'no_response']);

export const InteractionEvent = Base.extend({
  type: z.literal('interaction'),
  kind: InteractionKind,
  command: z.string().max(32).optional(),
  group: z.string().max(32).optional(),
  sub: z.string().max(32).optional(),
  commandId: Snowflake.optional(),
  commandScope: z.enum(['global', 'guild']).optional(),
  options: z.array(z.string().max(32)).max(25).default([]),
  optionValues: z.record(z.string().max(32), z.union([z.string().max(100), z.number(), z.boolean()])).optional(),
  /** Already normalised by the SDK (`ticket:close:*`). */
  customId: z.string().max(100).optional(),
  componentType: z.number().int().optional(),
  /** Command that created the message a component lives on. */
  sourceCommand: z.string().max(32).optional(),
  /** 0 server, 1 bot DM, 2 private channel. */
  context: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
  install: z.enum(['guild', 'user', 'both']).optional(),
  guild: Snowflake.optional(),
  channelType: z.number().int().optional(),
  locale: z.string().max(10),
  guildLocale: z.string().max(10).optional(),
  memberTier: z.enum(['admin', 'manager', 'member', 'dm']).optional(),
  user: UserHash,
  actor: Actor.optional(),
  premium: z.boolean(),
  outcome: InteractionOutcome,
  /** DiscordAPIError code, e.g. 10062 (Unknown Interaction). */
  errorCode: z.number().int().optional(),
  /** Error constructor name only, never a message or stack. */
  errorClass: z.string().max(64).optional(),
  ackMs: z.number().int().nonnegative().optional(),
  /** Interaction callback type, e.g. 5 = deferred, 9 = modal. */
  responseType: z.number().int().optional(),
  deferred: z.boolean().optional(),
  ephemeral: z.boolean().optional(),
  handlerMs: z.number().int().nonnegative().optional(),
  shard: z.number().int().nonnegative().optional(),
});

export const GuildInfo = z.object({
  guild: Snowflake,
  /** Untrusted text: render as text only, neutralise in CSV. */
  name: z.string().max(100),
  icon: z.string().max(64).nullable(),
  memberCount: z.number().int().nonnegative(),
  large: z.boolean(),
  preferredLocale: z.string().max(10),
  features: z.array(z.string().max(64)).max(64),
  premiumTier: z.number().int().min(0).max(3),
  boosts: z.number().int().nonnegative().nullable(),
  verificationLevel: z.number().int(),
  nsfwLevel: z.number().int(),
  mfaLevel: z.number().int(),
  createdAt: Ts,
  joinedAt: Ts,
  shard: z.number().int().nonnegative(),
  /** Channel counts keyed by channel type number. Counts only, never names. */
  channelCounts: z.record(z.string(), z.number().int().nonnegative()),
  roleCount: z.number().int().nonnegative(),
  emojiCount: z.number().int().nonnegative(),
  stickerCount: z.number().int().nonnegative(),
  /** Bot permission bitfield as a decimal string. */
  botPermissions: z.string().regex(/^\d+$/),
});

export const GuildJoin = Base.extend({
  type: z.literal('guild_join'),
  info: GuildInfo,
  detectedAtStartup: z.boolean(),
});

export const GuildUpdate = Base.extend({
  type: z.literal('guild_update'),
  info: GuildInfo,
});

export const GuildLeave = Base.extend({
  type: z.literal('guild_leave'),
  guild: Snowflake,
  detectedAtStartup: z.boolean(),
});

export const GuildAvailability = Base.extend({
  type: z.literal('guild_availability'),
  guild: Snowflake,
  available: z.boolean(),
  shard: z.number().int(),
});

export const GuildSnapshot = Base.extend({
  type: z.literal('guild_snapshot'),
  shards: z.array(z.number().int().nonnegative()),
  shardCount: z.number().int().positive(),
  guilds: z.array(Snowflake).max(2500 * 16),
});

export const CommandRegistry = Base.extend({
  type: z.literal('command_registry'),
  commands: z
    .array(
      z.object({
        id: Snowflake,
        name: z.string().max(32),
        type: z.number().int(),
        guild: Snowflake.optional(),
        subcommands: z.array(z.string().max(65)).default([]),
      }),
    )
    .max(5000),
});

export const ShardState = Base.extend({
  type: z.literal('shard_state'),
  shard: z.number().int(),
  state: z.enum(['ready', 'resumed', 'reconnecting', 'disconnected', 'error', 'invalidated']),
  closeCode: z.number().int().optional(),
  replayed: z.number().int().optional(),
  unavailableGuilds: z.number().int().optional(),
});

/** Number of latency histogram buckets: log scale, 1 ms .. 60 s. Must match `@shardlens/core` and SQL. */
export const HISTOGRAM_BUCKETS = 40;
export const Histogram = z.array(z.number().int().nonnegative()).length(HISTOGRAM_BUCKETS);

export const RestWindow = Base.extend({
  type: z.literal('rest_window'),
  windowMs: z.number().int().positive(),
  rows: z
    .array(
      z.object({
        method: z.string().max(8),
        /** Bucketed route only (`/interactions/:id/:token/callback`), never the raw path. */
        route: z.string().max(200),
        status: z.number().int(),
        count: z.number().int().positive(),
        retries: z.number().int().nonnegative(),
        latency: Histogram,
      }),
    )
    .max(2000),
  invalid: z.object({
    count401: z.number().int(),
    count403: z.number().int(),
    count429: z.number().int(),
    shared429: z.number().int(),
  }),
});

export const RateLimit = Base.extend({
  type: z.literal('rate_limit'),
  scope: z.enum(['user', 'global', 'shared']),
  global: z.boolean(),
  route: z.string().max(200),
  method: z.string().max(8),
  limit: z.number().int(),
  retryAfter: z.number().nonnegative(),
  sublimitTimeout: z.number().nonnegative(),
});

export const InvalidRequestWarning = Base.extend({
  type: z.literal('invalid_request_warning'),
  count: z.number().int(),
  remainingTime: z.number(),
});

export const GaugeWindow = Base.extend({
  type: z.literal('gauge_window'),
  gauges: z
    .array(
      z.object({
        name: z.string().max(64),
        shard: z.number().int().optional(),
        value: z.number(),
      }),
    )
    .max(500),
});

export const EntitlementEvent = Base.extend({
  type: z.literal('entitlement'),
  action: z.enum(['create', 'update', 'delete']),
  sku: Snowflake,
  entitlementType: z.number().int(),
  owner: z.enum(['user', 'guild']),
  user: UserHash.optional(),
  guild: Snowflake.optional(),
  startsAt: Ts.nullable(),
  endsAt: Ts.nullable(),
});

export const SubscriptionEvent = Base.extend({
  type: z.literal('subscription'),
  action: z.enum(['create', 'update', 'delete']),
  status: z.number().int(),
  skus: z.array(Snowflake),
  user: UserHash,
  periodStart: Ts,
  periodEnd: Ts,
});

/** Custom event names: lower snake case, starting with a letter, up to 64 characters. */
export const CUSTOM_EVENT_NAME = /^[a-z][a-z0-9_]{0,63}$/;

export const CustomEvent = Base.extend({
  type: z.literal('custom'),
  name: z.string().regex(CUSTOM_EVENT_NAME),
  props: z.record(z.string().max(64), z.union([z.string().max(256), z.number(), z.boolean(), z.null()])).default({}),
  user: UserHash.optional(),
  guild: Snowflake.optional(),
});

/** Sent every 30 minutes by the process that owns shard 0. Team member IDs are used only for dashboard login checks. */
export const AppInfo = Base.extend({
  type: z.literal('app_info'),
  name: z.string().max(100),
  approximateGuildCount: z.number().int().nullable(),
  approximateUserInstallCount: z.number().int().nullable(),
  approximateUserAuthorizationCount: z.number().int().nullable(),
  /** App owner, or accepted team members. */
  dashboardUserIds: z.array(Snowflake).max(100),
  /** 1 disabled, 2 enabled, 3 disabled by Discord. */
  eventWebhooksStatus: z.number().int().nullable(),
  skus: z.array(z.object({ id: Snowflake, name: z.string().max(100), type: z.number().int() })).max(200),
  sessionStartRemaining: z.number().int().optional(),
  sessionStartTotal: z.number().int().optional(),
  nodeVersion: z.string().max(32),
  libVersion: z.string().max(32),
});

export const SdkHealth = Base.extend({
  type: z.literal('sdk_health'),
  queueDepth: z.number().int(),
  dropped: z.record(z.string(), z.number().int()),
  failedFlushes: z.number().int(),
  internalErrors: z.record(z.string(), z.number().int()),
});

/**
 * A wrapped handler failed after the interaction's first response, so the failure could not be recorded on the
 * `interaction` event itself.
 */
export const InteractionError = Base.extend({
  type: z.literal('interaction_error'),
  /** `id` of the `interaction` event this error belongs to. */
  interaction: Id,
  command: z.string().max(32).optional(),
  /** Error constructor name only, never a message or stack. */
  errorClass: z.string().max(64),
  errorCode: z.number().int().optional(),
  handlerMs: z.number().int().nonnegative().optional(),
});

/** A server changed who may use the app's commands (`APPLICATION_COMMAND_PERMISSIONS_UPDATE`). */
export const CommandPermissions = Base.extend({
  type: z.literal('command_permissions'),
  guild: Snowflake,
  /** Command ID, or the application ID when the change applies to every command. */
  command: Snowflake,
  /** Number of permission overwrites now set. */
  overwrites: z.number().int().nonnegative(),
});

export const Event = z.discriminatedUnion('type', [
  InteractionEvent,
  InteractionError,
  CommandPermissions,
  GuildJoin,
  GuildUpdate,
  GuildLeave,
  GuildAvailability,
  GuildSnapshot,
  CommandRegistry,
  ShardState,
  RestWindow,
  RateLimit,
  InvalidRequestWarning,
  GaugeWindow,
  EntitlementEvent,
  SubscriptionEvent,
  CustomEvent,
  AppInfo,
  SdkHealth,
]);

export const Mode = z.enum(['privacy', 'audit']);

export const MAX_BATCH_EVENTS = 500;
/** Maximum batch size before compression, in bytes. The SDK splits larger batches. */
export const MAX_BATCH_BYTES = 1024 * 1024;
/** The collector's cap on a decompressed body, in bytes (gzip-bomb guard). */
export const MAX_DECOMPRESSED_BYTES = 5 * 1024 * 1024;

/** Batch envelope with events left unparsed, so the collector can validate events one by one. */
export const BatchEnvelope = z.object({
  v: z.literal(WIRE_VERSION),
  mode: Mode,
  sdk: z.object({ name: z.string().max(64), version: z.string().max(32) }),
  app: z.object({ id: Snowflake, env: z.string().max(32), release: z.string().max(64).optional() }),
  source: z.object({
    shards: z.array(z.number().int()),
    cluster: z.number().int().optional(),
    instance: z.string().max(128),
  }),
  sentAt: z.iso.datetime(),
  events: z.array(z.unknown()).min(1).max(MAX_BATCH_EVENTS),
});

/**
 * Returns a reason when an event carries identifying data that its batch mode does not allow.
 * In privacy mode no interaction may carry an `actor`.
 */
export function privacyViolation(event: Event, mode: Mode): string | undefined {
  if (mode === 'audit') return undefined;
  if (event.type === 'interaction' && event.actor !== undefined) return 'actor_in_privacy_mode';
  return undefined;
}

/** A whole batch, fully validated. Privacy-mode batches carrying identifying fields are rejected. */
export const Batch = BatchEnvelope.extend({
  events: z.array(Event).min(1).max(MAX_BATCH_EVENTS),
}).superRefine((batch, ctx) => {
  batch.events.forEach((event, i) => {
    const reason = privacyViolation(event, batch.mode);
    if (reason) ctx.addIssue({ code: 'custom', message: reason, path: ['events', i] });
  });
});

export type Mode = z.infer<typeof Mode>;
export type Actor = z.infer<typeof Actor>;
export type GuildInfo = z.infer<typeof GuildInfo>;
export type InteractionKind = z.infer<typeof InteractionKind>;
export type InteractionOutcome = z.infer<typeof InteractionOutcome>;

/** Validated (output) types: defaults applied. */
export type Batch = z.output<typeof Batch>;
export type BatchEnvelope = z.output<typeof BatchEnvelope>;
export type Event = z.output<typeof Event>;
export type EventType = Event['type'];
export type InteractionEvent = z.output<typeof InteractionEvent>;
export type GuildJoin = z.output<typeof GuildJoin>;
export type GuildUpdate = z.output<typeof GuildUpdate>;
export type GuildLeave = z.output<typeof GuildLeave>;
export type GuildAvailability = z.output<typeof GuildAvailability>;
export type GuildSnapshot = z.output<typeof GuildSnapshot>;
export type CommandRegistry = z.output<typeof CommandRegistry>;
export type ShardState = z.output<typeof ShardState>;
export type RestWindow = z.output<typeof RestWindow>;
export type RateLimit = z.output<typeof RateLimit>;
export type InvalidRequestWarning = z.output<typeof InvalidRequestWarning>;
export type GaugeWindow = z.output<typeof GaugeWindow>;
export type EntitlementEvent = z.output<typeof EntitlementEvent>;
export type SubscriptionEvent = z.output<typeof SubscriptionEvent>;
export type CustomEvent = z.output<typeof CustomEvent>;
export type AppInfo = z.output<typeof AppInfo>;
export type SdkHealth = z.output<typeof SdkHealth>;
export type InteractionError = z.output<typeof InteractionError>;
export type CommandPermissions = z.output<typeof CommandPermissions>;

/** What an SDK may send (input types: defaulted fields are optional). */
export type BatchInput = z.input<typeof Batch>;
export type EventInput = z.input<typeof Event>;
