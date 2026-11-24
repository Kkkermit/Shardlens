import type { QueryResults } from '@shardlens/client';
import type { Event } from '@shardlens/schema';
import type { QuerySpec, Spec } from '../query/spec.js';
import type { ApiKeyScope } from '../security/keys.js';
import type { MirroredCustom, MirroredInteraction } from './clickhouse.js';
import type { SaltPeriod } from './periods.js';

/*
 * Everything the collector keeps goes through one `Store`, so a storage engine other than PostgreSQL can serve the
 * same HTTP API, jobs and dashboard (ADR 0021). Methods take and return plain values: no SQL, no connections and no
 * transactions. Where an engine needs a transaction or a lock to keep a promise a method makes, it takes it inside
 * the method. Inputs arrive validated (zod at the HTTP boundary); the store never sees a raw user ID, only salted
 * hashes and values encrypted outside it.
 */

export type AppMode = 'privacy' | 'audit';

/** An app's own settings, kept with the app. */
export interface AppRecord {
  mode: AppMode;
  saltPeriod: SaltPeriod;
  /** IANA time zone the dashboard's charts and the reports use. */
  timezone: string;
  /** Days single events are kept, 7 to 90. */
  rawRetentionDays: number;
}

/** `GET /v1/meta`, less what the collector's configuration adds. */
export interface AppMeta extends AppRecord {
  appId: string;
  /** The name set for the app, else the one the bot reported, else `Your bot`. */
  name: string;
}

export interface AppStorage {
  /**
   * Adds the app unless it exists, with privacy mode, monthly salts, UTC and 35 days of raw retention. `name` is
   * used only when the app is added.
   */
  register(appId: string, name?: string): Promise<void>;
  get(appId: string): Promise<AppRecord | undefined>;
  /** Every app, for the jobs that work per app. */
  list(): Promise<{ appId: string; saltPeriod: SaltPeriod }[]>;
  /** Changes only the fields given. */
  update(appId: string, changes: Partial<AppRecord>): Promise<void>;
  /** `true` when the mode was another before. */
  setMode(appId: string, mode: AppMode): Promise<boolean>;
  meta(appId: string): Promise<AppMeta | undefined>;
  /**
   * Whether the user owns the application or is on its team, as the bot last reported (`app_info`). `undefined` when
   * the bot has not reported yet.
   */
  isDashboardUser(appId: string, userId: string): Promise<boolean | undefined>;
  /** Whether the bot has reported its application (`app_info`) at least once. */
  hasReported(appId: string): Promise<boolean>;
}

export interface ApiKeyRecord {
  id: string;
  appId: string;
  scope: ApiKeyScope;
}

/** A key as the Settings page lists it. */
export interface ApiKeyListing {
  id: string;
  scope: ApiKeyScope;
  label: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

/** A key to store. Only its SHA-256 is ever stored: the plaintext is shown once and forgotten. */
export interface NewApiKey {
  appId: string;
  scope: ApiKeyScope;
  sha256: Buffer;
  label: string;
}

export interface KeyStorage {
  /** The key with this SHA-256, unless it was revoked. */
  findActive(sha256: Buffer): Promise<ApiKeyRecord | undefined>;
  /** Records that the key was used now. */
  touch(id: string): Promise<void>;
  /** The scopes of the app's keys that are not revoked. */
  activeScopes(appId: string): Promise<ApiKeyScope[]>;
  /** Every key of the app, revoked ones included, newest first. */
  list(appId: string): Promise<ApiKeyListing[]>;
  /** Returns the new key's ID. */
  create(key: NewApiKey): Promise<string>;
  /** `false` when the app has no such key, or it was already revoked. */
  revoke(appId: string, id: string): Promise<boolean>;
  /**
   * A key from the collector's environment, labelled with its variable. Only a key not stored before does anything:
   * it is stored, the app's other unrevoked keys with the same scope and label are revoked, their sessions deleted,
   * and each revocation is written to the admin audit (`key_revoke`, by `environment`). A collector still started with
   * an older value therefore can't revoke the newer one.
   */
  ensureFromEnvironment(key: NewApiKey): Promise<void>;
}

export type SessionMethod = 'discord' | 'read_key';

export interface NewSession {
  /** SHA-256 of the cookie's token: the token itself is never stored. */
  idSha256: Buffer;
  appId: string;
  /** `null` for read-key sessions. */
  userId: string | null;
  method: SessionMethod;
  /** The read key a read-key session was opened with. */
  keyId: string | null;
  expiresAt: Date;
}

export interface SessionStorage {
  create(session: NewSession): Promise<void>;
  /** A session that has not expired, unless the key it was opened with has been revoked. */
  find(idSha256: Buffer): Promise<{ appId: string; userId: string | null; method: SessionMethod } | undefined>;
  delete(idSha256: Buffer): Promise<void>;
  /** Signs out every session opened with this key. */
  deleteForKey(keyId: string): Promise<void>;
}

/** The app settings kept by key, and their values. */
export interface SettingValues {
  /** 1 to 90. */
  audit_retention_days: number;
  /** Permission bits as a decimal string. */
  required_permissions: string;
  /** By SKU ID. */
  sku_prices: Record<string, { amount: number; currency: string }>;
  /** Sample rates by event type, sent to the SDK. */
  sampling: Record<string, number>;
  /** The public badges turned on. */
  badges: string[];
}

export type SettingKey = keyof SettingValues;

export interface SettingStorage {
  /** `undefined` when the setting was never saved. */
  get<K extends SettingKey>(appId: string, key: K): Promise<SettingValues[K] | undefined>;
  all(appId: string): Promise<Partial<SettingValues>>;
  set<K extends SettingKey>(appId: string, key: K, value: SettingValues[K]): Promise<void>;
  delete(appId: string, key: SettingKey): Promise<void>;
  /** Whether the store can cut charts in this time zone, so Settings refuses one it can't. */
  supportsTimeZone(name: string): Promise<boolean>;
}

/** A period's salt, made outside the store (`storage/salts.ts`). */
export interface NewSalt {
  /** Salt period label: `2026-11`, `2026-W46` or `2026-11-13`. */
  period: string;
  /** 32 random bytes. */
  secret: Buffer;
  periodEnd: Date;
  /** When the job destroys the secret: the end of the period plus a grace week. */
  destroyAfter: Date;
}

/**
 * Salts pseudonymise users (ADR 0001). A destroyed salt keeps its row with the secret gone, so its period can never be
 * salted again.
 */
export interface SaltStorage {
  /**
   * Stores the salt unless the app already has one for its period, and makes ready whatever that period's unique-user
   * rows need (PostgreSQL: a partition). Several collectors may call it at once for the same period.
   */
  ensure(appId: string, salt: NewSalt): Promise<void>;
  /** Of `periods`, those whose secret is still there and not due for destruction at `now`. */
  alive(appId: string, periods: readonly string[], now: Date): Promise<{ period: string; secret: Buffer }[]>;
  /** Every period whose secret is still there and not due for destruction at `now`. */
  livePeriods(appId: string, now: Date): Promise<Set<string>>;
  /** The period's secret, unless it is due for destruction now (or destroyed). */
  secret(appId: string, period: string): Promise<Buffer | undefined>;
  /** Every secret not destroyed yet, due or not: an erase by user ID hashes with each. */
  liveSecrets(appId: string): Promise<Buffer[]>;
  /** Salts due for destruction at `now` whose secret is still there, for every app. */
  expired(now: Date): Promise<{ appId: string; period: string }[]>;
  /**
   * Destroys the salt: deletes the period's unique-user rows, removes the secret and records `now` as when. Final
   * unique counts are written before this is called.
   */
  destroy(appId: string, period: string, now: Date): Promise<void>;
}

/** Who ran a command in audit mode, encrypted outside the store with the audit key. Stored as it is. */
export interface SealedActor {
  /** Deterministic key, so a lookup by exact user ID needs no decryption. */
  lookup: Buffer;
  /** The user ID, encrypted. */
  userId: Buffer;
  /** Username and avatar, encrypted together. `null` when the SDK sent neither. */
  profile: Buffer | null;
}

export interface IngestItem {
  /** Position in the submitted batch, for rejections. */
  index: number;
  /** Validated, its time corrected for the sender's clock. Never carries `actor`: see `actor` here. */
  event: Event;
  /** For interactions and message commands, only in audit mode and within audit retention. */
  actor?: SealedActor | undefined;
}

export interface IngestContext {
  appId: string;
  env: string;
  release: string | undefined;
  /** The sending bot process. */
  instance: string;
  /** The shards that process holds. */
  shards: number[];
  /** `name@version` of the SDK. */
  sdkVersion: string;
  /** Salt periods whose salt is alive: an event hashed in any other is rejected as `unknown_salt_period`. */
  livePeriods: ReadonlySet<string>;
  now: Date;
  /** Also return what was stored for the ClickHouse analytics store (`WriteResult.mirror`). */
  mirror?: boolean | undefined;
}

export interface WriteResult {
  /** Events stored now. */
  accepted: number;
  /** Events already stored by an earlier attempt of the batch. */
  duplicates: number;
  rejected: { index: number; reason: string }[];
  /** IDs, lower case, of the interactions and message commands stored now (retried ones left out): live tiles count them. */
  stored: Set<string>;
  /** With `IngestContext.mirror`: the interactions and custom events stored now, never retried ones. */
  mirror?: { interactions: MirroredInteraction[]; custom: MirroredCustom[] } | undefined;
}

export interface IngestStorage {
  /**
   * Stores a batch, all of it or none of it. Each event is stored once by its UUIDv7 (with its time), so a retried
   * batch comes back as duplicates. Server joins, leaves, profiles, snapshots, the command registry and app info are
   * applied in batch order; an event more than 2 minutes old marks its minute for the rollup job to recompute.
   * Concurrent batches share unique-user rows and late minutes, so an engine with row locks writes those in one order.
   */
  write(ctx: IngestContext, items: readonly IngestItem[]): Promise<WriteResult>;
  /**
   * As `write`, one event at a time, after `write` threw an error `Store.refusedInput` recognises: an event the store
   * refuses is rejected alone, as `refused_by_database`, and the others are stored.
   */
  writeEach(ctx: IngestContext, items: readonly IngestItem[]): Promise<WriteResult>;
}

/** One Discord webhook event delivery (an install or an entitlement change). */
export interface WebhookDelivery {
  /** Derived from the body, so Discord's retry of a delivery has the same ID and is stored once. */
  id: string;
  ts: Date;
  appId: string;
  /** Discord's event type, such as `APPLICATION_AUTHORIZED`. */
  type: string;
  /** 0 server install, 1 user install. */
  integrationType: number | null;
  userHash: Buffer | null;
  /** The installing user's ID, encrypted with the audit key, in audit mode only. */
  actor: Buffer | null;
  guildId: string | null;
  scopes: string[] | null;
}

/** An entitlement created, updated or deleted, from the gateway (ingest) or a webhook event. */
export interface EntitlementChange {
  appId: string;
  ts: Date;
  action: 'create' | 'update' | 'delete';
  skuId: string;
  entitlementType: number;
  owner: 'user' | 'guild';
  userHash: Buffer | null;
  guildId: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
}

export interface WebhookEventStorage {
  /** Stores the delivery unless one with its ID is stored. */
  record(delivery: WebhookDelivery): Promise<void>;
  /** Stores an entitlement change that arrived as a webhook event. */
  recordEntitlement(change: EntitlementChange): Promise<void>;
}

/**
 * A value as a store hands it over for an answer the HTTP API sends as JSON: a `Date` may stand wherever a string is,
 * since JSON writes it as the ISO 8601 string the client reads. Other strings keep the format the client documents
 * (days as `YYYY-MM-DD`, chart points without an offset).
 */
export type Stored<T> = T extends string
  ? string extends T
    ? string | Date
    : T
  : T extends readonly (infer U)[]
    ? Stored<U>[]
    : T extends object
      ? { [K in keyof T]: Stored<T[K]> }
      : T;

/**
 * The answer to a query of kind `K`: the shape `@shardlens/client` types (`results.ts`), which the dashboard reads too.
 * `test/client.int.test.ts` checks every answer against it, strictly.
 */
export type QueryAnswer<K extends QuerySpec['kind']> = Stored<QueryResults[K]>;

/** A series point from rollups. `key` is the `groupBy` dimension as stored (`''` for events without it, or no `groupBy`). */
export interface SeriesRow {
  /** Start of the interval in the spec's time zone, without an offset: `2026-11-16T00:00:00`. */
  t: string;
  key: string | null;
  value: number | null;
}

/** A top row from rollups. `key` is the `groupBy` dimension as stored (`''` for events without it). */
export interface TopRow {
  key: string;
  /** The spec's `stat`. */
  value: number | null;
  count: number;
}

export interface HeatmapCell {
  /** ISO weekday in the spec's time zone, 1 Monday to 7 Sunday. */
  weekday: number;
  hour: number;
  value: number;
}

export interface GuildName {
  id: string;
  name: string;
  icon: string | null;
}

/**
 * Every query kind of `POST /v1/query`, plus the lookups the shared query code needs. Specs arrive parsed by
 * `QuerySpec` (defaults applied). Dimension values are stored as the codes in `ingest/codes.ts` (`query/dimensions.ts`
 * turns API names into codes and back). Single events are read only as far back as the app's raw retention; rollups
 * by minute for 14 days, by hour for 13 months and by day after that (the rollup job writes them).
 */
export interface QueryStorage {
  /**
   * `series` from the rollups of `metric` (the spec's metric resolved: `custom.<name>`, or `interactions.by_guild` when
   * it groups or filters by server). The `limit` keys with the most events, filters matched against stored codes.
   */
  series(appId: string, spec: Spec<'series'>, metric: string, now: Date): Promise<SeriesRow[]>;
  /** `top` from the rollups of `metric` (see `series`), highest `stat` first. */
  top(appId: string, spec: Spec<'top'>, metric: string, now: Date): Promise<TopRow[]>;
  /** Events of `metric` by weekday and hour, from hourly rollups (the last 13 months at most). */
  heatmap(appId: string, spec: Spec<'heatmap'>, metric: string, now: Date): Promise<HeatmapCell[]>;
  commands(appId: string, spec: Spec<'commands'>, now: Date): Promise<QueryAnswer<'commands'>>;
  command(appId: string, spec: Spec<'command'>, now: Date): Promise<QueryAnswer<'command'>>;
  servers(appId: string, spec: Spec<'servers'>, now: Date): Promise<QueryAnswer<'servers'>>;
  server(appId: string, spec: Spec<'server'>, now: Date): Promise<QueryAnswer<'server'>>;
  growth(appId: string, spec: Spec<'growth'>, now: Date): Promise<QueryAnswer<'growth'>>;
  audience(appId: string, spec: Spec<'audience'>, now: Date): Promise<QueryAnswer<'audience'>>;
  overview(appId: string, spec: Spec<'overview'>, now: Date): Promise<QueryAnswer<'overview'>>;
  gauge(appId: string, spec: Spec<'gauge'>, now: Date): Promise<QueryAnswer<'gauge'>>;
  bursts(appId: string, spec: Spec<'bursts'>, now: Date): Promise<QueryAnswer<'bursts'>>;
  reliability(appId: string, spec: Spec<'reliability'>, now: Date): Promise<QueryAnswer<'reliability'>>;
  premium(appId: string, spec: Spec<'premium'>, now: Date): Promise<QueryAnswer<'premium'>>;
  installs(appId: string, spec: Spec<'installs'>, now: Date): Promise<QueryAnswer<'installs'>>;
  events(appId: string, spec: Spec<'events'>, now: Date): Promise<QueryAnswer<'events'>>;
  eventProps(appId: string, spec: Spec<'eventProps'>, now: Date): Promise<QueryAnswer<'eventProps'>>;
  /** Links a person's steps by salted hash inside the store and returns counts only. */
  funnel(appId: string, spec: Spec<'funnel'>, now: Date): Promise<QueryAnswer<'funnel'>>;
  /** As `funnel`: counts only, a person known by salted hash. */
  retention(appId: string, spec: Spec<'retention'>, now: Date): Promise<QueryAnswer<'retention'>>;
  /** Names and icons of the servers with these IDs that the store has a profile for. */
  guildNames(appId: string, ids: readonly string[]): Promise<GuildName[]>;
  /**
   * A public badge's number: `servers` (the bot is in now), `users-monthly` (unique users of the latest salt period)
   * or `commands-daily` (runs in the last 24 hours). `null` when there is none.
   */
  badge(appId: string, metric: string): Promise<number | null>;
}

export interface AdminAuditStorage {
  /** Records something a person (`userId`), or the collector's configuration (`null`), changed. No secrets in `details`. */
  record(appId: string, userId: string | null, action: string, details?: object): Promise<void>;
}

export interface Store {
  readonly apps: AppStorage;
  readonly keys: KeyStorage;
  readonly sessions: SessionStorage;
  readonly settings: SettingStorage;
  readonly salts: SaltStorage;
  readonly ingest: IngestStorage;
  readonly webhookEvents: WebhookEventStorage;
  readonly query: QueryStorage;
  readonly adminAudit: AdminAuditStorage;
  /**
   * Makes ready, at start-up, whatever the coming week's events need (PostgreSQL: daily partitions from the start of
   * each table's retention to a week ahead). Several collectors may run it at once.
   */
  prepare(): Promise<void>;
  /** Resolves when the store can serve (`GET /readyz`); rejects when it can't. */
  ready(): Promise<void>;
  /**
   * The store's code for an error that means it refused the input itself (a number out of range, text it can't hold),
   * which no retry can fix: the request is answered 400, and an ingest batch is written event by event. `undefined`
   * for any other error.
   */
  refusedInput(error: unknown): string | undefined;
}
