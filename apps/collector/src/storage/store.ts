import type { QueryResults } from '@shardlens/client';
import type { Event } from '@shardlens/schema';
import type { ReportSchedule } from '../jobs/reports.js';
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

export interface Store {
  readonly apps: AppStorage;
  readonly keys: KeyStorage;
  readonly sessions: SessionStorage;
  readonly settings: SettingStorage;
  readonly salts: SaltStorage;
  readonly ingest: IngestStorage;
  readonly webhookEvents: WebhookEventStorage;
  readonly query: QueryStorage;
  readonly alerts: AlertStorage;
  readonly reports: ReportStorage;
  readonly privacy: PrivacyStorage;
  readonly adminAudit: AdminAuditStorage;
  readonly live: LiveStorage;
  readonly jobs: JobStorage;
  readonly demo: DemoStorage;
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

interface ApiKeyRecord {
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
interface NewApiKey {
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

interface NewSession {
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
interface NewSalt {
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
  /** IDs, lower case, of the interactions and message commands stored now, not retried ones: live tiles count these. */
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
interface WebhookDelivery {
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

/** An entitlement created, updated or deleted, as a webhook event reports it (the gateway's come through ingest). */
interface EntitlementChange {
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
type Stored<T> = T extends string
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

export interface AlertRule {
  id: string;
  name: string;
  /** One of `ALERT_METRICS` (`routes/admin.ts`). */
  metric: string;
  comparator: '>' | '>=' | '<' | '<=';
  threshold: number;
  /** 60 to 86,400. */
  windowS: number;
  /** The Discord webhook URL, encrypted with the settings key. */
  webhook: Buffer;
  enabled: boolean;
  lastFired: Date | null;
}

/** An enabled rule, for the alert job, which checks every app's. */
interface ActiveAlertRule extends Omit<AlertRule, 'enabled'> {
  appId: string;
}

/** A rule firing, as the Alerts page lists it. */
export interface AlertFiring {
  ts: Date;
  ruleId: string;
  /** The rule's name. */
  name: string;
  value: number;
  delivered: boolean;
  error: string | null;
}

export interface AlertStorage {
  /** The app's rules, oldest first. */
  list(appId: string): Promise<AlertRule[]>;
  /** The app's last 50 firings, newest first. */
  history(appId: string): Promise<AlertFiring[]>;
  get(appId: string, id: string): Promise<Pick<AlertRule, 'name' | 'webhook'> | undefined>;
  /** Returns the new rule's ID. */
  create(appId: string, rule: Omit<AlertRule, 'id' | 'enabled' | 'lastFired'>): Promise<string>;
  /** `false` when the app has no such rule. */
  setEnabled(appId: string, id: string, enabled: boolean): Promise<boolean>;
  /** Deletes the rule and its history. `false` when the app has no such rule. */
  delete(appId: string, id: string): Promise<boolean>;
  /** Every app's enabled rules. */
  active(): Promise<ActiveAlertRule[]>;
  /**
   * The metric's value over the trailing `windowS` seconds (`invalid_requests_pct` always over 10 minutes: Discord's
   * own window), or `null` when there is no data to judge: no rule fires on missing data.
   */
  metricValue(appId: string, metric: string, windowS: number): Promise<number | null>;
  /** Records that the rule fired at `at`, and whether Discord took the message. */
  recordFiring(
    rule: { id: string; appId: string },
    at: Date,
    value: number,
    delivered: boolean,
    error: string | null,
  ): Promise<void>;
}

interface Report {
  id: string;
  name: string;
  schedule: ReportSchedule;
  /** Hour of the day to send at, in the app's time zone. */
  hour: number;
  /** ISO weekday (1 Monday to 7 Sunday), for weekly reports. */
  weekday: number;
  /** The Discord webhook URL, encrypted with the settings key. */
  webhook: Buffer;
  enabled: boolean;
  lastSent: Date | null;
  lastError: string | null;
}

/** A report to send now, with the period it covers worked out in the app's time zone. */
export interface ReportToSend {
  id: string;
  appId: string;
  name: string;
  schedule: ReportSchedule;
  webhook: Buffer;
  timezone: string;
  /** The app's name, as `AppMeta.name`. */
  bot: string;
  /** Midnight starting the local day before `dayEnd`. */
  dayStart: Date;
  /** Midnight starting the local day seven days before `dayEnd`. */
  weekStart: Date;
  /** The midnight that started the local day `now` is in. */
  dayEnd: Date;
}

export interface ReportStorage {
  /** The app's reports, oldest first. */
  list(appId: string): Promise<Report[]>;
  count(appId: string): Promise<number>;
  /** Returns the new report's ID. */
  create(appId: string, report: Omit<Report, 'id' | 'enabled' | 'lastSent' | 'lastError'>): Promise<string>;
  /** `false` when the app has no such report. */
  setEnabled(appId: string, id: string, enabled: boolean): Promise<boolean>;
  /** `false` when the app has no such report. */
  delete(appId: string, id: string): Promise<boolean>;
  /**
   * Every enabled report whose hour has come in its app's time zone at `now` (on its weekday, for weekly ones) and that
   * has not been sent since the local day began. In ID order.
   */
  due(now: Date): Promise<ReportToSend[]>;
  /** One report, due or not, for its last finished period at `now`. */
  find(appId: string, id: string, now: Date): Promise<ReportToSend | undefined>;
  /** Records an attempt: `error` is `null` when Discord took the message. */
  recordSent(id: string, at: Date, error: string | null): Promise<void>;
}

/** A read of audit data, or an erase, for the access log. */
interface AccessLogEntry {
  appId: string;
  /** The person's Discord ID, `'0'` for an activity key or the SDK. */
  viewerUserId: string;
  /** The activity key that read, if one did. */
  viewerKeyId: string | null;
  action: string;
  details: object;
}

/** The access log as `GET /v1/audit/access-log` answers it. */
export interface AccessLogRow {
  ts: Date;
  viewerUserId: string;
  /** The label of the key that read, if one did. */
  viewerKey: string | null;
  action: string;
  details: unknown;
}

/** Filters of the activity log. Every one given must match. */
interface ActivityFilter {
  from?: string | undefined;
  to?: string | undefined;
  /** Rows before this time, or before this time and row ID together (paging: the row ID breaks ties). */
  before?: { ts: string; id?: string | undefined } | undefined;
  command?: string | undefined;
  guild?: string | undefined;
  /** `SealedActor.lookup` of the user looked up. */
  actorLookup?: Buffer | undefined;
  /** One outcome, or `failed` for every outcome but `ok`. */
  outcome?: 'ok' | 'error' | 'timeout' | 'no_response' | 'failed' | undefined;
}

/** One run in the activity log (audit mode), its identity still encrypted. */
interface ActivityRecord {
  interactionId: string;
  ts: Date;
  guildId: string | null;
  /** From the server's profile, if the store has one. */
  guildName: string | null;
  /** Code from `KIND`. */
  kind: number;
  command: string | null;
  sub: string | null;
  customId: string | null;
  /** Code from `OUTCOME`. */
  outcome: number;
  ackMs: number | null;
  /** `SealedActor.userId`. */
  userId: Buffer;
  /** `SealedActor.profile`. */
  profile: Buffer | null;
}

/** Erasure, audit mode's activity log and the access log of who read it (ADR 0002, 0011). */
export interface PrivacyStorage {
  logAccess(entry: AccessLogEntry): Promise<void>;
  /** The app's last 200 access log entries, newest first. */
  accessLog(appId: string): Promise<AccessLogRow[]>;
  /**
   * Deletes the app's single events, unique-user rows, entitlements, subscriptions and webhook deliveries with any of
   * these salted hashes. Rollups stay: they are anonymous counts. Returns the rows deleted.
   */
  eraseHashes(appId: string, hashes: readonly Buffer[]): Promise<number>;
  /** Deletes the user's activity log. Returns the rows deleted. */
  eraseActivity(appId: string, actorLookup: Buffer): Promise<number>;
  /** The app's webhook deliveries that keep an encrypted installing user. */
  installers(appId: string): Promise<{ id: string; ts: Date; actor: Buffer }[]>;
  /** Forgets the installing user of one delivery. */
  forgetInstaller(id: string, ts: Date): Promise<void>;
  /** Newest first (by time, then row ID), at most `limit` rows. */
  activity(appId: string, filter: ActivityFilter, limit: number): Promise<ActivityRecord[]>;
  /**
   * The 25 users with the most runs in the last 24 hours or 7 days, by `SealedActor.lookup`, each with their latest
   * encrypted ID. Read only through the access-logged activity routes.
   */
  topActors(appId: string, window: '24h' | '7d'): Promise<{ userId: Buffer; runs: number }[]>;
}

/** Live tile counts one collector instance shares with the others: interactions and failures per second. */
export interface LiveShare {
  /** The instance that counted them: random, per process. */
  instance: string;
  appId: string;
  /** `[epoch second, interactions, failures]`. Not validated on the way in: whatever receives a share checks it. */
  counts: [number, number, number][];
}

/** Carries live tile counts between the collector instances on one store, so every instance shows the same tiles. */
export interface LiveChannel {
  /**
   * Starts handing `receive` what instances publish (an instance's own shares may come back; they are ignored).
   * Resolves `false` when it could not subscribe yet: it keeps trying in the background, and tells `warn` once per
   * outage when a subscription is lost. A store with no way to push (PostgreSQL has `LISTEN`) may poll here.
   */
  subscribe(receive: (share: LiveShare) => void, warn: (message: string) => void): Promise<boolean>;
  /**
   * Sends counts to the other instances, about once a second. Best effort: a lost share costs a second of tiles. A
   * store may hold counts back while no other instance has a live stream open (`listen`), as long as the last 15
   * minutes of them reach an instance whose stream opens.
   */
  publish(share: LiveShare): Promise<void>;
  /**
   * Whether this instance has a live stream open: `true` when the first one opens, `false` when the last one closes. A
   * store that pays for every read may poll, and have the others send their counts, only while one is. A store that
   * pushes (PostgreSQL's `LISTEN`) needs no telling.
   */
  listen?(active: boolean): void;
  stop(): Promise<void>;
}

/** What the live stream reads from the store about every 10 seconds, besides the counts it keeps in memory. */
interface LiveRecent {
  /** 95th percentile of the time to the first response over the last 5 minutes. */
  p95Ms5m: number | null;
  /** Each shard's latest ping in the last hour. `fresh` when under 2 minutes old. */
  shards: { shard: number; ping: number; fresh: boolean }[];
  /** Servers the bot is in now. */
  servers: number;
}

export interface LiveStorage {
  /** A channel for one live hub: one per collector process. */
  channel(): LiveChannel;
  recent(appId: string): Promise<LiveRecent>;
}

/** One contender for job leadership: one collector instance on a store runs the scheduled jobs. */
export interface JobLeader {
  /**
   * Tries to become the leader; `true` when this instance is now. Called every 30 seconds while it isn't. Staying leader
   * is the store's job (PostgreSQL: a session advisory lock on a connection of its own; elsewhere, for example, a lease
   * the store renews): if leadership ends without `release`, the store calls `onLost` once, and the scheduler tries
   * again. Another instance must not lead while this one does.
   */
  tryLead(onLost: () => void): Promise<boolean>;
  /** Gives leadership up, at shutdown. Nothing tries to lead with this contender afterwards. */
  release(): Promise<void>;
}

/** The scheduled jobs' storage work. Only the leader runs them, one at a time. */
export interface JobStorage {
  leader(): JobLeader;
  /**
   * The every-minute rollup run: recomputes minute, hour and day rollups for recent minutes and for minutes late events
   * marked (at most 6 hours of those per run), newest first. A rollup that fails on its data (an overflowing sum) is
   * skipped and listed instead of stopping the others. `since` is when the previous run started.
   */
  runRollups(now?: Date, opts?: { since?: Date | undefined }): Promise<{ windows: number; skipped: string[] }>;
  /**
   * Recomputes rollups for [from, to): minutes for the last 14 days, hours and days from those, and from single events
   * while they are kept for older periods. Periods older than raw retention are left alone.
   */
  backfillRollups(from: Date, to: Date, now?: Date): Promise<void>;
  /**
   * Unique-user counts for every live salt period (or one app, or one period): per day with new users, per ISO week
   * wholly inside the period, and for the whole period. `final` marks them final; a final count is never rewritten.
   */
  runUniques(appId?: string, period?: string, final?: boolean): Promise<void>;
  /** The hourly job: what `Store.prepare` does, for retention as set, giving up rather than wait on busy storage. */
  ensurePartitions(now: Date): Promise<void>;
  /**
   * The daily job: hourly rollups after 13 months, servers left 90 days ago, expired sessions, access and admin logs
   * after a year, SDK health of processes silent for 30 days, then single events and minute rollups past retention.
   * Throws when something could not be deleted yet, so it runs again soon.
   */
  runRetention(now: Date): Promise<void>;
}

/** For the demo seeder (`cli/seed.ts`): fictional data must never be mixed into a real bot's. */
export interface DemoStorage {
  /** Whether the app has no interactions stored. */
  isEmpty(appId: string): Promise<boolean>;
  /** Keeps the period's salt alive for another hour, so last period's demo users can still be hashed. */
  extendSalt(appId: string, period: string): Promise<void>;
  /** Forgets the minutes late events marked for the rollup job, once a backfill has recomputed everything. */
  clearLateMarks(): Promise<void>;
}

export interface AdminAuditStorage {
  /** Records something a person (`userId`), or the collector's configuration (`null`), changed. No secrets in `details`. */
  record(appId: string, userId: string | null, action: string, details?: object): Promise<void>;
}
