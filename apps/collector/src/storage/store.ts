import type { ApiKeyScope } from '../security/keys.js';
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

export interface AdminAuditStorage {
  /** Records something a person (`userId`), or the collector's configuration (`null`), changed. No secrets in `details`. */
  record(appId: string, userId: string | null, action: string, details?: object): Promise<void>;
}

export interface Store {
  readonly apps: AppStorage;
  readonly keys: KeyStorage;
  readonly sessions: SessionStorage;
  readonly settings: SettingStorage;
  readonly adminAudit: AdminAuditStorage;
  /** Resolves when the store can serve (`GET /readyz`); rejects when it can't. */
  ready(): Promise<void>;
  /**
   * The store's code for an error that means it refused the input itself (a number out of range, text it can't hold),
   * which no retry can fix: the request is answered 400, and an ingest batch is written event by event. `undefined`
   * for any other error.
   */
  refusedInput(error: unknown): string | undefined;
}
