import { COLLECTED_FIELDS, type Event } from '@shardlens/schema';
import { parseUserHash } from '../ingest/codes.js';

/**
 * Event sinks copy every event the collector accepted into a database the bot owner already runs (MongoDB, MySQL,
 * MariaDB, PostgreSQL, SQLite) or into code they write. PostgreSQL (or PGlite) stays the collector's own store and
 * the dashboard's source; a sink is a copy for the owner's own queries (ADR 0019).
 *
 * Copies are privacy-safe: users are the same salted hashes PostgreSQL stores, every field the data-collected register
 * marks as identifying is removed, and erasure and retention reach the sink too.
 */

/** One event as a sink stores it. */
export interface StoredEvent {
  /** The event's UUIDv7. Sinks must ignore an ID they already hold, so a retried batch is stored once. */
  id: string;
  ts: Date;
  appId: string;
  env: string;
  release: string | null;
  type: string;
  guildId: string | null;
  /** The salted user hash as 32 hex characters (no period), or `null` for events without a user. */
  userHash: string | null;
  /** Salt period of `userHash`, such as `2026-11`. */
  saltPeriod: string | null;
  /** The validated event, without the fields that identify a person. */
  data: Record<string, unknown>;
}

/** A destination for copies of accepted events. Implement it to send events anywhere; every method may throw. */
export interface EventSink {
  /** Short name used in log lines, such as `mongodb`. */
  readonly name: string;
  /** Creates the table or collection and its indexes if needed. Called before the first write, and again after a failure. */
  init?(): Promise<void>;
  /** Stores events, ignoring IDs already stored. */
  write(events: readonly StoredEvent[]): Promise<void>;
  /** Right to erasure: deletes every event with one of these user hashes (32 hex characters). Returns rows deleted. */
  erase(appId: string, userHashes: readonly string[]): Promise<number>;
  /** Deletes events older than `before`. Returns rows deleted. */
  expire(before: Date): Promise<number>;
  close(): Promise<void>;
}

export interface SinkSettings {
  /** Where to copy events: a connection URL (see {@link createSink}) or a sink object. */
  to: string | EventSink;
  /** Table or collection name. Default `shardlens_events`. */
  table?: string | undefined;
  /** Days to keep copies. Default 35, like raw rows; at most 3,650. */
  retentionDays?: number | undefined;
  /** Event types to copy (for example `interaction`, `message_command`, `custom`). Default: every type. */
  events?: readonly string[] | undefined;
}

export const SINK_URL = /^(mongodb(\+srv)?|mysql|mariadb|postgres(ql)?|sqlite):/i;
/** At most 48 characters, so `<table>_app_ts` and the other index names fit MySQL's 64. */
export const SINK_TABLE = /^[A-Za-z_][A-Za-z0-9_]{0,47}$/;
export const DEFAULT_SINK_TABLE = 'shardlens_events';
const MAX_BUFFER = 20_000;
const BATCH = 500;
const FLUSH_MS = 2_000;
const EXPIRE_EVERY_MS = 6 * 60 * 60_000;
const WARN_EVERY_MS = 60_000;
/** Consecutive failed writes while the database is reachable before rows are tried one by one. */
const POISON_AFTER = 3;

/**
 * Fields the data-collected register marks as identifying (`personal: 'yes'`), by event type: audit-mode `actor` and the
 * app team's IDs in `app_info`. They stay in the collector (encrypted, or for sign-in only) and are never copied.
 */
const IDENTIFYING = new Map<string, Set<string>>();
for (const field of COLLECTED_FIELDS) {
  if (field.personal !== 'yes') continue;
  const set = IDENTIFYING.get(field.object) ?? new Set<string>();
  set.add(field.field);
  IDENTIFYING.set(field.object, set);
}
/** Nested objects that have register entries of their own. */
const NESTED: Readonly<Record<string, string>> = { info: 'guild_info' };

function withoutIdentifying(object: string, value: Record<string, unknown>): Record<string, unknown> {
  const hidden = IDENTIFYING.get(object);
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (hidden?.has(key)) continue;
    const nested = NESTED[key];
    out[key] = nested && v && typeof v === 'object' ? withoutIdentifying(nested, v as Record<string, unknown>) : v;
  }
  return out;
}

/** Removes a password from anything URL-shaped, so driver errors can be logged. */
export function withoutCredentials(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi, '$1***@');
}

/** Opens the built-in sink for a connection URL. Drivers load only when their scheme is used. */
export async function createSink(url: string, table = DEFAULT_SINK_TABLE): Promise<EventSink> {
  if (!SINK_TABLE.test(table)) throw new Error('sink table must be a plain identifier (letters, digits, underscores)');
  const scheme = /^([a-z0-9+]+):/i.exec(url)?.[1]?.toLowerCase();
  switch (scheme) {
    case 'mongodb':
    case 'mongodb+srv':
      return new (await import('./sinks/mongodb.js')).MongoSink(url, table);
    case 'mysql':
    case 'mariadb':
      return new (await import('./sinks/mysql.js')).MysqlSink(url.replace(/^mariadb:/i, 'mysql:'), table);
    case 'postgres':
    case 'postgresql':
      return new (await import('./sinks/postgres.js')).PostgresSink(url, table);
    case 'sqlite':
      return new (await import('./sinks/sqlite.js')).SqliteSink(url.replace(/^sqlite:(\/\/)?/i, ''), table);
    default:
      throw new Error('sink URL must start with mongodb:, mongodb+srv:, mysql:, mariadb:, postgres: or sqlite:');
  }
}

function guildOf(event: Event): string | null {
  if (event.type === 'guild_join' || event.type === 'guild_update') return event.info.guild;
  return 'guild' in event && typeof event.guild === 'string' ? event.guild : null;
}

/** The copy of one accepted event, without the fields that identify a person. */
export function toStoredEvent(
  ctx: { appId: string; env: string; release: string | undefined },
  event: Event,
): StoredEvent {
  const data = withoutIdentifying(event.type, event as unknown as Record<string, unknown>);
  const user = 'user' in event && typeof event.user === 'string' ? parseUserHash(event.user) : undefined;
  return {
    id: event.id,
    ts: new Date(event.ts),
    appId: ctx.appId,
    env: ctx.env,
    release: ctx.release ?? null,
    type: event.type,
    guildId: guildOf(event),
    userHash: user ? user.bytes.toString('hex') : null,
    saltPeriod: user ? user.period : null,
    data,
  };
}

/**
 * Buffers copies and writes them in the background. Ingest only ever calls {@link SinkMirror.push}, which never throws
 * or waits: when the sink is down, copies wait in a bounded buffer and are dropped (and counted) once it is full.
 */
export class SinkMirror {
  readonly #sink: EventSink;
  readonly #types: ReadonlySet<string> | undefined;
  readonly #retentionMs: number;
  #buffer: StoredEvent[] = [];
  #ready = false;
  #preparing: Promise<boolean> | undefined;
  #flushing: Promise<void> | undefined;
  #timers: ReturnType<typeof setInterval>[] = [];
  #warn: (message: string) => void = () => undefined;
  #warnedAt = 0;
  #failures = 0;
  /** Copies dropped because the buffer was full, or because the database refused them. */
  dropped = 0;

  constructor(sink: EventSink, settings: Pick<SinkSettings, 'retentionDays' | 'events'> = {}) {
    this.#sink = sink;
    this.#types = settings.events && settings.events.length > 0 ? new Set(settings.events) : undefined;
    const days = Math.min(3650, Math.max(1, Math.floor(settings.retentionDays ?? 35)));
    this.#retentionMs = days * 86_400_000;
  }

  get name(): string {
    return this.#sink.name;
  }

  /**
   * Starts writing in the background. The sink is prepared on the first flush, and again after a failure, so a database
   * that is slow or down never delays or stops the collector.
   */
  start(warn?: (message: string) => void): void {
    if (warn) this.#warn = warn;
    const flush = setInterval(() => void this.flush(), FLUSH_MS);
    const expire = setInterval(
      () => void this.expire().catch((e: unknown) => this.#report('expiry', e)),
      EXPIRE_EVERY_MS,
    );
    flush.unref();
    expire.unref();
    this.#timers.push(flush, expire);
    void this.#init()
      .then((ready) => (ready ? this.expire() : 0))
      .catch((e: unknown) => this.#report('expiry', e));
  }

  /** Queues copies of accepted events. Never throws, never blocks. */
  push(ctx: { appId: string; env: string; release: string | undefined }, events: readonly Event[]): void {
    try {
      const wanted = this.#types ? events.filter((e) => this.#types?.has(e.type)) : events;
      if (wanted.length === 0) return;
      if (this.#buffer.length + wanted.length > MAX_BUFFER) {
        this.dropped += wanted.length;
        this.#report('buffer', new Error(`buffer full, ${this.dropped} copies dropped so far`));
        return;
      }
      for (const event of wanted) this.#buffer.push(toStoredEvent(ctx, event));
    } catch (error) {
      this.#report('push', error);
    }
  }

  /** Writes buffered copies. A failed write keeps them for the next try. */
  flush(): Promise<void> {
    this.#flushing ??= this.#flush().finally(() => {
      this.#flushing = undefined;
    });
    return this.#flushing;
  }

  /** Deletes a person's copies, including any still waiting in the buffer. Throws if the sink can't be reached. */
  async erase(appId: string, hashes: readonly Buffer[]): Promise<number> {
    if (hashes.length === 0) return 0;
    const hex = new Set(hashes.map((h) => h.toString('hex')));
    const unbuffer = () => {
      const before = this.#buffer.length;
      this.#buffer = this.#buffer.filter((e) => e.appId !== appId || e.userHash === null || !hex.has(e.userHash));
      return before - this.#buffer.length;
    };
    let removed = unbuffer();
    // A batch being written now either lands (and the delete below removes it) or comes back to the buffer.
    await this.#flushing?.catch(() => undefined);
    removed += unbuffer();
    if (!(await this.#init())) throw new Error(`${this.#sink.name} sink is unreachable; erase it again later`);
    return removed + (await this.#sink.erase(appId, [...hex]));
  }

  async expire(now = new Date()): Promise<number> {
    if (!this.#ready) return 0;
    return this.#sink.expire(new Date(now.getTime() - this.#retentionMs));
  }

  async stop(): Promise<void> {
    for (const t of this.#timers) clearInterval(t);
    this.#timers = [];
    await this.flush();
    await this.#sink.close().catch((e: unknown) => this.#report('close', e));
  }

  /** Prepares the sink once; callers that arrive while it is being prepared wait for the same attempt. */
  #init(): Promise<boolean> {
    if (this.#ready) return Promise.resolve(true);
    this.#preparing ??= (async () => {
      try {
        await this.#sink.init?.();
        this.#ready = true;
      } catch (error) {
        this.#report('setup', error);
      }
      return this.#ready;
    })().finally(() => {
      this.#preparing = undefined;
    });
    return this.#preparing;
  }

  async #flush(): Promise<void> {
    if (this.#buffer.length === 0 || !(await this.#init())) return;
    while (this.#buffer.length > 0) {
      const batch = this.#buffer.splice(0, BATCH);
      try {
        await this.#sink.write(batch);
        this.#failures = 0;
      } catch (error) {
        this.#report('write', error);
        // The database answers set-up but keeps refusing this batch: some row in it is bad. Write the rows one by one
        // and drop only those it refuses, so one bad row can't hold up everything behind it.
        if (++this.#failures >= POISON_AFTER) {
          this.#failures = 0;
          await this.#writeEach(batch);
          continue;
        }
        // Back to the front, oldest first, as far as the buffer allows; the rest is dropped and counted.
        const room = Math.max(0, MAX_BUFFER - this.#buffer.length);
        this.dropped += Math.max(0, batch.length - room);
        this.#buffer = [...batch.slice(Math.max(0, batch.length - room)), ...this.#buffer];
        this.#ready = false;
        return;
      }
    }
  }

  async #writeEach(batch: readonly StoredEvent[]): Promise<void> {
    let refused = 0;
    for (const event of batch) {
      try {
        await this.#sink.write([event]);
      } catch {
        refused++;
      }
    }
    if (refused === 0) return;
    this.dropped += refused;
    this.#warnedAt = 0;
    this.#report('write', new Error(`dropped ${refused} copies the database refused`));
  }

  #report(what: string, error: unknown): void {
    const now = Date.now();
    if (now - this.#warnedAt < WARN_EVERY_MS) return;
    this.#warnedAt = now;
    const message = error instanceof Error ? error.message : 'unknown error';
    this.#warn(`${this.#sink.name} sink ${what} failed: ${withoutCredentials(message)}`);
  }
}
