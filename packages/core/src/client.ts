import type { ShardlensExporter } from './exporter.js';
import { periodLabel, type SaltPeriod, UserHasher } from './hash.js';
import { cutText, redactSecrets } from './normalise.js';
import { BoundedQueue, PRIORITIES, type Priority, type QueuedItem } from './queue.js';
import type { EventSpool } from './spool.js';
import { backoffMs, gzip, isAllowedEndpoint } from './transport.js';
import { uuidv7 } from './uuidv7.js';

/** The fields every wire event has. Adapters pass full event objects from `@shardlens/schema`. */
export interface WireEvent {
  id: string;
  ts: number;
  type: string;
  weight?: number | undefined;
}

export type DataMode = 'privacy' | 'audit';

/** Where log lines go. Every message is passed through `redactSecrets` first. */
export interface Logger {
  debug?(message: string): void;
  info?(message: string): void;
  warn(message: string): void;
}

/** Identifies the sending process: shards it owns, cluster (hybrid sharding) and a host label. */
export interface SourceInfo {
  shards: number[];
  cluster?: number;
  instance: string;
}

export interface ClientOptions {
  /**
   * Collector base URL. HTTPS, or HTTP to localhost only. Leave out together with `apiKey` to run without a collector
   * (exporters only).
   */
  endpoint?: string | undefined;
  /** Ingest-only key (`slk_ingest_…`). */
  apiKey?: string | undefined;
  /** In-process metrics exporters (Prometheus, OpenTelemetry). They receive every event, without users. */
  exporters?: readonly ShardlensExporter[] | undefined;
  /** Durable overflow for long collector outages (for example a disk spool). See {@link EventSpool}. */
  spool?: EventSpool | undefined;
  sdk: { name: string; version: string };
  /** `'audit'` only takes effect when the collector is also in audit mode. Default `'privacy'`. */
  mode?: DataMode;
  /** Separates staging from live. Default `'production'`. */
  environment?: string;
  /** Your bot's version, to compare releases. */
  release?: string;
  /** Flush interval. Default 5,000 ms. */
  flushIntervalMs?: number;
  /** Events per batch (max 500). Default 500. */
  maxBatchSize?: number;
  /** Memory ceiling, in events. Default 10,000. */
  maxQueueSize?: number;
  /** Sample rate per event type, in (0, 1]. Kept events carry `weight = 1 / rate`. The collector's settings win. */
  sampleRate?: Readonly<Record<string, number>>;
  /** Print events instead of sending them. Hashes use a throwaway local salt. */
  dryRun?: boolean;
  /** Called for the current shard/cluster information each time a batch is built. */
  source?: () => SourceInfo;
  logger?: Logger;
  /** Override for tests and unusual runtimes. */
  fetch?: typeof fetch;
  /** Randomness in [0, 1), for jitter and sampling. Injectable for tests. */
  random?: () => number;
}

export interface FlushOptions {
  /** Give up after this long. Default 2,000 ms. */
  timeoutMs?: number;
}

/** A snapshot of the SDK's own health, also sent as the `sdk_health` event. */
export interface ClientStats {
  queueDepth: number;
  pendingSalt: number;
  dropped: Record<string, number>;
  failedFlushes: number;
  internalErrors: Record<string, number>;
  ready: boolean;
  mode: DataMode | undefined;
  /** Events written to the spool during this process's lifetime (0 without a spool). */
  spooled: number;
  /** Spooled events the collector has since accepted. */
  replayed: number;
}

type ErrorListener = (name: string, error: unknown) => void;

interface PendingHash<E> {
  userId: string;
  ts: number;
  priority: Priority;
  build: (userHash: string) => E;
  addedAt: number;
}

interface RemoteConfig {
  appId: string;
  mode: DataMode;
  saltPeriod: SaltPeriod;
  sampling: Record<string, number>;
}

const MAX_BATCH_EVENTS = 500;
const MAX_BATCH_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const PENDING_SALT_MAX = 1_000;
const PENDING_SALT_MAX_AGE_MS = 60_000;
const AUTH_RETRY_MS = 5 * 60_000;
const CONFIG_REFRESH_MS = 60 * 60_000;
/** Asking again for a salt period's salt that the collector hasn't made yet: a few tries, 5 to 30 seconds apart. */
const SALT_RETRIES = 10;
const SALT_RETRY_MIN_MS = 5_000;
const SALT_RETRY_SPREAD_MS = 25_000;
/**
 * The collector hands out the next period's salt in the last 5 minutes of a period. Asking for it 1 to 4 minutes
 * before the boundary means no event waits for a salt when the period changes.
 */
const NEXT_SALT_LEAD_MS = 4 * 60_000;
const NEXT_SALT_SPREAD_MS = 3 * 60_000;
/** How often events for a period without a salt may make the SDK ask for settings outside its schedule. */
const SALT_ASK_INTERVAL_MS = 30_000;
const OUTAGE_WARN_INTERVAL_MS = 5 * 60_000;
/** The collector refuses events weighing more than 10,000, so a lower rate would lose every event it keeps. */
const MIN_SAMPLE_RATE = 1 / 10_000;
/** A clock this far off the collector's starts salt periods at the wrong time. */
const CLOCK_SKEW_WARN_MS = 30_000;
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_REPLY_BYTES = 64 * 1024;
/** Erasures remembered, so events recorded before one and still on their way are dropped. */
const MAX_ERASED = 10_000;
const MAX_BATCHES_PER_FLUSH = 20;
const SALT_RE = /^[A-Za-z0-9_-]{43}$/;
const SNOWFLAKE_RE = /^\d{17,20}$/;
/** Longer timer delays overflow, and Node then fires them after 1 ms. */
const MAX_TIMER_MS = 2 ** 31 - 1;

function unref(timer: unknown): void {
  (timer as { unref?: () => void } | undefined)?.unref?.();
}

/**
 * A numeric option as an integer within `[min, max]`, or `fallback` when it isn't a finite number. Options are often
 * read from environment variables, where a missing one becomes `NaN`.
 */
function intOption(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/** Waits for `work`, or for `ms` at most. */
async function settleWithin(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    unref(timer);
  });
  try {
    await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Releases a response body that won't be read. */
async function discard(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => undefined);
}

/**
 * Parses a JSON reply of at most `maxBytes` once decompressed, or gives `undefined`. A misbehaving collector or proxy
 * can't make the bot buffer and parse an unbounded body.
 */
async function readJson(res: Response, maxBytes: number): Promise<unknown> {
  const declared = Number(res.headers.get('content-length'));
  if (!res.body || declared > maxBytes) {
    await discard(res);
    return undefined;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
}

/** A string option, also from a number (environment variables, wrangler vars), cut to `max`. Anything else: unset. */
function textOption(value: unknown, max: number): string | undefined {
  const text =
    typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'bigint' ? String(value) : '';
  return text.length > 0 ? cutText(text, max) : undefined;
}

function isExporter(value: unknown): value is ShardlensExporter {
  return typeof value === 'object' && value !== null && typeof (value as ShardlensExporter).observe === 'function';
}

/** The exporters in `value`, which should be an array, and whether it was one of exporters only. */
function exporterList(value: unknown): { exporters: ShardlensExporter[]; valid: boolean } {
  if (value === undefined || value === null) return { exporters: [], valid: true };
  if (Array.isArray(value)) {
    const exporters = value.filter(isExporter);
    return { exporters, valid: exporters.length === value.length };
  }
  // A single exporter, passed without the array.
  return { exporters: isExporter(value) ? [value] : [], valid: false };
}

/**
 * What `on('error')` listeners get: a plain error with the original's class name, code and status, and its message,
 * stack and URL with secrets removed. A discord.js REST error carries the request URL, which for an interaction reply
 * holds the interaction token, and the request body, which is left out.
 */
function listenerError(error: unknown): unknown {
  try {
    if (typeof error === 'string') return redactSecrets(error);
    if (typeof error !== 'object' || error === null) return error;
    const e = error as Record<string, unknown>;
    const safe = new Error(redactSecrets(typeof e.message === 'string' ? e.message : '')) as Error &
      Record<string, unknown>;
    safe.name = typeof e.name === 'string' ? e.name : 'Error';
    safe.stack = typeof e.stack === 'string' ? redactSecrets(e.stack) : `${safe.name}: ${safe.message}`;
    for (const key of ['code', 'status', 'method']) {
      const value = e[key];
      if (typeof value === 'string' || typeof value === 'number') safe[key] = value;
    }
    if (typeof e.url === 'string') safe.url = redactSecrets(e.url);
    return safe;
  } catch {
    return new Error('unreadable error');
  }
}

function base64UrlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Start of the next salt period after `at`, in epoch ms (UTC). */
export function nextPeriodStart(period: SaltPeriod, at: Date): number {
  const y = at.getUTCFullYear();
  const m = at.getUTCMonth();
  const d = at.getUTCDate();
  if (period === 'day') return Date.UTC(y, m, d + 1);
  if (period === 'month') return Date.UTC(y, m + 1, 1);
  const dow = at.getUTCDay() || 7; // Monday = 1
  return Date.UTC(y, m, d + (8 - dow));
}

/** Parses `Retry-After` (seconds or HTTP date) into milliseconds from now. Callers never wait less than the backoff. */
function retryAfterMs(header: string | null, now: number): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 10 * 60_000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.min(date - now, 10 * 60_000));
}

/** Removes the audit-only `actor` so nothing identifying is sent when the effective mode is privacy. */
function stripIdentifying<E extends WireEvent>(event: E): E {
  if (!('actor' in event)) return event;
  const { actor: _actor, ...rest } = event as E & { actor?: unknown };
  return rest as unknown as E;
}

/** The hashed user an event carries, if any. Spooled events come back from disk, possibly as anything. */
function userOf(event: WireEvent): string | undefined {
  const user = (event as { user?: unknown } | null)?.user;
  return typeof user === 'string' ? user : undefined;
}

/**
 * How many of a batch's first `n` events the collector's `rejected` list names, each once. The health event at the
 * end of the batch is not one of them.
 */
function rejectedCount(rejected: unknown, n: number): number {
  const seen = new Set<unknown>();
  if (Array.isArray(rejected)) {
    for (const r of rejected) {
      const index = (r as { index?: unknown } | null)?.index;
      if (Number.isInteger(index) && (index as number) >= 0 && (index as number) < n) seen.add(index);
    }
  }
  return seen.size;
}

/** What `/v1/ingest` made of a batch: how many of its events it rejected once it took the batch, or why it didn't. */
type SendResult = number | 'retry' | 'audit_off' | 'too_large' | 'refused';

/**
 * The transport half of the SDK: a bounded priority queue, salt bootstrap, sampling, gzip batching, retries and
 * shutdown. Library adapters (such as `@shardlens/discordjs`) turn library events into wire events and enqueue them.
 *
 * Nothing here throws into the caller: every failure is caught, counted in {@link ClientStats.internalErrors} and
 * reported to `on('error')` listeners.
 */
export class ShardlensClient<E extends WireEvent = WireEvent> {
  readonly #opts: Required<Pick<ClientOptions, 'flushIntervalMs' | 'maxBatchSize' | 'environment'>> & ClientOptions;
  readonly #queue: BoundedQueue<E>;
  readonly #hasher = new UserHasher();
  readonly #fetch: typeof fetch;
  readonly #random: () => number;
  readonly #logger: Logger;
  readonly #listeners = new Set<ErrorListener>();
  readonly #internalErrors = new Map<string, number>();
  readonly #extraDropped = { salt_missing: 0, invalid: 0, closed: 0, spool_full: 0 };
  readonly #warned = new Set<string>();
  #pendingSalt: PendingHash<E>[] = [];
  #config: RemoteConfig | undefined;
  #failedFlushes = 0;
  #attempt = 0;
  #configAttempt = 0;
  #retryAt = 0;
  #batchCap: number;
  #flushing: Promise<void> | undefined;
  #spilling: Promise<void> | undefined;
  #flushScheduled = false;
  #flushTimer: unknown;
  #configTimer: unknown;
  /** `shutdown()` has started: new events are refused. */
  #closed = false;
  #stopping: Promise<void> | undefined;
  /** `shutdown()` has returned: nothing more is sent, so events still being hashed are dropped. */
  #stopped = false;
  /** Nothing is sent (no collector, or a misconfigured one): events only go to exporters. */
  #disabled = false;
  /** Never in a dry run, which must not send what an earlier run stored. */
  readonly #spool: EventSpool | undefined;
  readonly #exporters: readonly ShardlensExporter[];
  #configLoading: Promise<void> | undefined;
  /** Hashing in progress (it is async: Web Crypto). */
  #inflight = 0;
  #idleWaiters: (() => void)[] = [];
  readonly #maxQueue: number;
  #spooled = 0;
  #replayed = 0;
  /** Erased user hashes, with when: their events recorded until then are dropped wherever they still wait. */
  readonly #erased = new Map<string, number>();
  #saltRetries = 0;
  #configAskedAt = 0;
  #outageWarnedAt = Number.NEGATIVE_INFINITY;
  /** Aborts requests still in flight once shutdown is over, so a hanging collector can't keep the process alive. */
  readonly #abort = new AbortController();

  constructor(options: ClientOptions) {
    this.#logger = options.logger ?? { warn: (m) => console.warn(m), info: (m) => console.info(m) };
    const { environment: rawEnvironment, release: rawRelease, exporters: rawExporters, ...rest } = options;
    const environment = textOption(rawEnvironment, 32);
    const release = textOption(rawRelease, 64);
    if (rawEnvironment !== undefined && rawEnvironment !== '' && environment === undefined) {
      this.#warn('environment', 'Shardlens: environment must be a string; using "production".');
    }
    if (rawRelease !== undefined && rawRelease !== '' && release === undefined) {
      this.#warn('release', 'Shardlens: release must be a string; it is left out.');
    }
    this.#opts = {
      ...rest,
      ...(release !== undefined ? { release } : {}),
      flushIntervalMs: intOption(options.flushIntervalMs, 250, MAX_TIMER_MS, 5_000),
      maxBatchSize: intOption(options.maxBatchSize, 1, MAX_BATCH_EVENTS - 1, MAX_BATCH_EVENTS - 1),
      environment: environment ?? 'production',
    };
    this.#batchCap = this.#opts.maxBatchSize;
    this.#maxQueue = intOption(options.maxQueueSize, 1, Number.MAX_SAFE_INTEGER, 10_000);
    this.#queue = new BoundedQueue<E>(this.#maxQueue);
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#random = options.random ?? Math.random;
    const { exporters, valid } = exporterList(rawExporters);
    if (!valid)
      this.#warn('exporters', 'Shardlens: exporters must be an array of exporters, such as [prometheusExporter()].');
    this.#exporters = exporters;
    this.#spool = options.dryRun ? undefined : options.spool;

    if (!options.dryRun && !options.endpoint && !options.apiKey) {
      this.#disabled = true;
      if (this.#exporters.length === 0) {
        this.#warn('endpoint', 'Shardlens: no endpoint, apiKey or exporters configured; nothing is recorded.');
      }
    } else if (!options.dryRun && !isAllowedEndpoint(options.endpoint ?? '')) {
      this.#disabled = true;
      this.#warn('endpoint', 'Shardlens: endpoint must be https:// (or http://localhost); sending is disabled.');
    } else if (!options.dryRun && !options.apiKey) {
      this.#disabled = true;
      this.#warn('apiKey', 'Shardlens: apiKey is missing; sending is disabled.');
    }

    this.#flushTimer = setInterval(() => void this.flush(), this.#opts.flushIntervalMs);
    unref(this.#flushTimer);
    if (options.dryRun) this.#configLoading = this.#initDryRun();
    else if (!this.#disabled) this.#configLoading = this.#loadConfig();
  }

  /** True once salts and settings have arrived from the collector (or the dry-run salt is ready). */
  get ready(): boolean {
    return this.#config !== undefined;
  }

  /** The effective data mode: audit only when both the SDK and the collector are in audit mode. */
  get mode(): DataMode | undefined {
    if (!this.#config) return undefined;
    return this.#config.mode === 'audit' && this.#opts.mode === 'audit' ? 'audit' : 'privacy';
  }

  /** Listens for internal errors. Listener exceptions are swallowed. */
  on(event: 'error', listener: ErrorListener): () => void {
    if (event === 'error') this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Queues an event. Applies sampling. Never throws. */
  enqueue(event: E, priority: Priority): void {
    try {
      if (this.#closed) {
        this.#extraDropped.closed++;
        return;
      }
      if (this.#exporters.length > 0) this.#export(event);
      if (this.#disabled) return;
      const sampled = this.#sample(event);
      if (!sampled) return;
      this.#queue.push(sampled, priority);
      if (this.#queue.size >= this.#batchCap) this.#scheduleFlush();
    } catch (error) {
      this.count('enqueue', error);
      this.#extraDropped.invalid++;
    }
  }

  /**
   * Queues an event that carries a user hash. The hash is computed in-process with the period's salt; if the salt
   * hasn't arrived yet, the event waits in a small bounded buffer (1,000 events, 60 seconds) and is then dropped.
   */
  enqueueWithUser(userId: string, ts: number, priority: Priority, build: (userHash: string) => E): void {
    try {
      if (this.#closed) {
        this.#extraDropped.closed++;
        return;
      }
      // Exporters see the event straight away, without a user (they never need one, and never wait for a salt).
      if (this.#exporters.length > 0) this.#export(build(''));
      if (this.#disabled) return;
      const label = this.#config ? periodLabel(this.#config.saltPeriod, new Date(ts)) : undefined;
      if (label && this.#hasher.hasSalt(label)) {
        void this.#hashAndQueue({ userId, ts, priority, build, addedAt: Date.now() }, label);
        return;
      }
      if (this.#config) this.#askForSalt();
      if (this.#pendingSalt.length >= PENDING_SALT_MAX) {
        this.#dropForSalt();
        return;
      }
      this.#pendingSalt.push({ userId, ts, priority, build, addedAt: Date.now() });
    } catch (error) {
      this.count('enqueue', error);
      this.#extraDropped.invalid++;
    }
  }

  /**
   * Hashes a user ID for the period containing `at`. Returns `undefined` if that period's salt isn't available.
   * Use it for erasure requests; event hashing goes through {@link ShardlensClient.enqueueWithUser}.
   */
  async hashUser(userId: string, at: Date = new Date()): Promise<string | undefined> {
    if (!this.#config) return undefined;
    try {
      return await this.#hasher.hash(userId, periodLabel(this.#config.saltPeriod, at));
    } catch (error) {
      this.count('hash', error);
      return undefined;
    }
  }

  /**
   * Asks the collector to delete everything stored for a user (right to erasure). Sends the user's hashes for every
   * salt period still installed; the raw ID is sent only in audit mode, where the collector already holds it
   * encrypted. Resolves to the number of rows removed, or `undefined` if the request could not be made. Never throws.
   */
  async forgetUser(userId: string): Promise<{ erased: number } | undefined> {
    const id = String(userId);
    // Events waiting for a salt hold the raw ID: drop them here, whatever happens next.
    this.#pendingSalt = this.#pendingSalt.filter((pending) => pending.userId !== id);
    if (!this.#config || this.#disabled || this.#opts.dryRun) return undefined;
    try {
      // Events being hashed reach the queue first, so they are dropped below rather than sent after the erasure.
      await this.idle();
      this.#pendingSalt = this.#pendingSalt.filter((pending) => pending.userId !== id);
      const hashes: string[] = [];
      for (const label of this.#hasher.labels()) {
        const h = await this.#hasher.hash(id, label);
        if (h) hashes.push(h);
      }
      const at = Date.now();
      for (const hash of hashes) this.#markErased(hash, at);
      // Not sent yet, so not stored yet: dropping them here is the erasure. While the collector is unreachable they
      // would otherwise arrive after the erasure request and survive it.
      this.#queue.removeWhere((event) => this.#isErased(event));
      try {
        await this.#spool?.drop?.((event) => this.#isErased(event));
      } catch (error) {
        this.count('spool_drop', error);
      }
      // A batch already on its way must be stored before the erasure runs, or it would survive it.
      await this.#flushing;
      const res = await this.#fetch(new URL('/v1/privacy/erase', this.#opts.endpoint), {
        method: 'POST',
        headers: { authorization: `Bearer ${this.#opts.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ userHashes: hashes, ...(this.mode === 'audit' ? { userId: id } : {}) }),
        signal: this.#signal(),
      });
      if (!res.ok) {
        await discard(res);
        this.count(`erase_${res.status}`);
        return undefined;
      }
      const body = (await readJson(res, MAX_REPLY_BYTES)) as { erased?: unknown } | undefined;
      return { erased: typeof body?.erased === 'number' ? body.erased : 0 };
    } catch (error) {
      this.count('erase', error);
      return undefined;
    }
  }

  /** Increments an internal error counter and notifies listeners. For adapters; never throws. */
  count(name: string, error?: unknown): void {
    this.#internalErrors.set(name, (this.#internalErrors.get(name) ?? 0) + 1);
    if (this.#listeners.size === 0) return;
    const safe = error === undefined ? undefined : listenerError(error);
    for (const listener of this.#listeners) {
      try {
        listener(name, safe);
      } catch {
        // a broken listener must not break the SDK
      }
    }
  }

  stats(): ClientStats {
    const dropped: Record<string, number> = { ...this.#extraDropped };
    for (let p = 0; p < PRIORITIES; p++) dropped[`p${p}`] = this.#queue.dropped[p] ?? 0;
    return {
      queueDepth: this.#queue.size,
      pendingSalt: this.#pendingSalt.length,
      dropped,
      failedFlushes: this.#failedFlushes,
      internalErrors: Object.fromEntries(this.#internalErrors),
      ready: this.ready,
      mode: this.mode,
      spooled: this.#spooled,
      replayed: this.#replayed,
    };
  }

  /**
   * Resolves once the first settings load has finished and no user hashing is in progress, or after `timeoutMs`.
   * Serverless runtimes call it before {@link ShardlensClient.flush} inside `waitUntil`, so the events of a short-lived
   * request are hashed and sent before the runtime stops. Never throws.
   */
  async idle(timeoutMs = 2_000): Promise<void> {
    const work = (async () => {
      await this.#configLoading;
      await this.#hashed();
    })().catch((error: unknown) => this.count('idle', error));
    await settleWithin(work, intOption(timeoutMs, 0, MAX_TIMER_MS, 2_000));
  }

  /** Sends queued events now. Concurrent calls share one flush. Never throws. */
  flush(): Promise<void> {
    if (!this.#flushing) {
      this.#flushing = this.#runFlush()
        .catch((error: unknown) => this.count('flush', error))
        .finally(() => {
          this.#flushing = undefined;
        });
    } else if (this.#spool && this.#queue.size >= this.#maxQueue - this.#batchCap) {
      // A request can hang for 10 seconds, while memory fills up and starts dropping events: spool them meanwhile.
      this.#spilling ??= this.#spill(false)
        .catch((error: unknown) => this.count('spool_write', error))
        .finally(() => {
          this.#spilling = undefined;
        });
    }
    return this.#flushing;
  }

  /**
   * Stops timers and flushes what is queued, giving up after `timeoutMs`. The SDK never installs signal handlers;
   * call this from your own shutdown code. Every call waits for the same flush. Never throws.
   */
  shutdown(options?: FlushOptions): Promise<void> {
    // `timeoutMs` often comes from an environment variable, where a missing one is NaN.
    this.#stopping ??= this.#stop(intOption(options?.timeoutMs, 0, MAX_TIMER_MS, 2_000));
    return this.#stopping;
  }

  async #stop(timeoutMs: number): Promise<void> {
    this.#closed = true;
    clearInterval(this.#flushTimer as ReturnType<typeof setInterval>);
    clearTimeout(this.#configTimer as ReturnType<typeof setTimeout>);
    const deadline = Date.now() + timeoutMs;
    const drain = (async () => {
      // Events recorded just before shutdown may still be waiting for their user hash, or already on their way.
      this.#drainPendingSalt();
      await this.#hashed();
      await this.#flushing;
      while (this.#queue.size > 0 && Date.now() < deadline && !this.#disabled) {
        if (this.#retryAt > Date.now()) break;
        const before = this.#queue.size;
        await this.flush();
        if (this.#queue.size >= before) break; // no progress (collector down): stop trying
      }
      // Whatever couldn't be sent survives the restart in the spool (if there is one).
      await this.#spill(true);
    })().catch((error: unknown) => this.count('shutdown', error));
    const exporters = Promise.all(
      this.#exporters.map(async (exporter) => {
        try {
          await exporter.shutdown?.();
        } catch (error) {
          this.count(`exporter:${exporter.name}`.slice(0, 64), error);
        }
      }),
    );
    await settleWithin(Promise.all([drain, exporters]), timeoutMs);
    // Past the deadline, a request still hanging is given up, so it can't keep the process alive; its batch goes back
    // to memory, and what is in memory goes to the spool (local, quick).
    this.#abort.abort();
    await settleWithin(this.#flushing ?? Promise.resolve(), 100);
    if (this.#spool && this.#queue.size > 0) {
      await settleWithin(
        this.#spill(true).catch((error: unknown) => this.count('shutdown', error)),
        1_000,
      );
    }
    this.#stopped = true;
    // Never sent now, and they hold raw user IDs.
    this.#extraDropped.salt_missing += this.#pendingSalt.length;
    this.#pendingSalt = [];
  }

  /** Every request's signal: its own timeout, and the end of shutdown. */
  #signal(): AbortSignal {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    return typeof AbortSignal.any === 'function' ? AbortSignal.any([timeout, this.#abort.signal]) : timeout;
  }

  #markErased(hash: string, at: number): void {
    this.#erased.delete(hash);
    this.#erased.set(hash, at);
    if (this.#erased.size > MAX_ERASED) this.#erased.delete(this.#erased.keys().next().value as string);
  }

  /** Recorded for a user, before that user's erasure. */
  #isErased(event: WireEvent): boolean {
    if (this.#erased.size === 0) return false;
    const user = userOf(event);
    const at = user === undefined ? undefined : this.#erased.get(user);
    return at !== undefined && event.ts <= at;
  }

  /** The retry delay after a 429, 503 or failed request: what `Retry-After` says, but never less than the backoff. */
  #backoff(retryAfter: string | null): number {
    const backoff = backoffMs(this.#attempt++, this.#random);
    return Math.max(backoff, retryAfterMs(retryAfter, Date.now()) ?? 0);
  }

  /** Resolves once no user hashing is in progress. */
  async #hashed(): Promise<void> {
    while (this.#inflight > 0) await new Promise<void>((resolve) => this.#idleWaiters.push(resolve));
  }

  #log(level: 'warn' | 'info', message: string): void {
    try {
      if (level === 'warn') this.#logger.warn(redactSecrets(message));
      else this.#logger.info?.(redactSecrets(message));
    } catch {
      // a broken logger must not break the SDK
    }
  }

  #warn(key: string, message: string): void {
    if (this.#warned.has(key)) return;
    this.#warned.add(key);
    this.#log('warn', message);
  }

  /**
   * The collector left audit mode while this SDK still believed in it. Continue in privacy mode at once (the caller
   * resends its batch without identities) rather than dropping batches until the hourly settings refresh.
   */
  #auditSwitchedOff(): void {
    if (this.#config) this.#config = { ...this.#config, mode: 'privacy' };
    this.#warn('audit_off', 'Shardlens: the collector is no longer in audit mode; sending privacy-mode data only.');
    this.#scheduleConfig(0);
  }

  #dropForSalt(): void {
    this.#extraDropped.salt_missing++;
    this.#warn(
      'salt_missing',
      'Shardlens: user events were dropped waiting for a salt from the collector (see stats().dropped.salt_missing).',
    );
  }

  /** One warning per outage, not one per failed request, and one every 5 minutes at most while the collector flaps. */
  #collectorDown(reason: unknown): void {
    if (this.#warned.has('unreachable') || Date.now() - this.#outageWarnedAt < OUTAGE_WARN_INTERVAL_MS) return;
    this.#outageWarnedAt = Date.now();
    const why = (reason instanceof Error ? reason.message : String(reason)).slice(0, 120);
    this.#warn(
      'unreachable',
      `Shardlens: can't reach the collector at ${this.#collector} (${why}). Retrying; events wait in memory.`,
    );
  }

  #collectorUp(): void {
    if (!this.#warned.delete('unreachable')) return;
    this.#log('info', `Shardlens: connected to the collector at ${this.#collector}.`);
  }

  get #collector(): string {
    try {
      return new URL(this.#opts.endpoint ?? '').origin;
    } catch {
      return 'the configured endpoint';
    }
  }

  #sample(event: E): E | undefined {
    const rate = this.#config?.sampling[event.type] ?? this.#opts.sampleRate?.[event.type];
    if (!(rate !== undefined && rate > 0 && rate < 1)) return event;
    const kept = Math.max(rate, MIN_SAMPLE_RATE);
    if (this.#random() >= kept) return undefined;
    return { ...event, weight: (event.weight ?? 1) / kept };
  }

  #scheduleFlush(): void {
    if (this.#flushScheduled) return;
    this.#flushScheduled = true;
    queueMicrotask(() => {
      this.#flushScheduled = false;
      void this.flush();
    });
  }

  /** Hashes and queues one event. Counted as in flight until done, for {@link ShardlensClient.idle}. */
  async #hashAndQueue(pending: PendingHash<E>, label: string): Promise<void> {
    this.#inflight++;
    try {
      const hash = await this.#hasher.hash(pending.userId, label);
      if (!hash) {
        this.#dropForSalt();
        return;
      }
      this.#queueHashed(pending.build(hash), pending.priority);
    } catch (error) {
      this.count('hash', error);
      this.#extraDropped.invalid++;
    } finally {
      // A counter rather than a set of promises: no extra allocation per event on the hot path.
      if (--this.#inflight === 0 && this.#idleWaiters.length > 0) {
        const waiters = this.#idleWaiters;
        this.#idleWaiters = [];
        for (const resolve of waiters) resolve();
      }
    }
  }

  #queueHashed(event: E, priority: Priority): void {
    if (this.#stopped) {
      this.#extraDropped.closed++;
      return;
    }
    if (this.#isErased(event)) return;
    const sampled = this.#sample(event);
    if (!sampled) return;
    this.#queue.push(sampled, priority);
    if (this.#queue.size >= this.#batchCap) this.#scheduleFlush();
  }

  #export(event: E): void {
    const clean = stripIdentifying(event);
    for (const exporter of this.#exporters) {
      try {
        exporter.observe(clean);
      } catch (error) {
        this.count(`exporter:${exporter.name}`.slice(0, 64), error);
      }
    }
  }

  #drainPendingSalt(): void {
    if (this.#pendingSalt.length === 0) return;
    const now = Date.now();
    const keep: PendingHash<E>[] = [];
    for (const pending of this.#pendingSalt) {
      const label = this.#config ? periodLabel(this.#config.saltPeriod, new Date(pending.ts)) : undefined;
      if (label && this.#hasher.hasSalt(label)) void this.#hashAndQueue(pending, label);
      else if (now - pending.addedAt > PENDING_SALT_MAX_AGE_MS) this.#dropForSalt();
      else keep.push(pending);
    }
    this.#pendingSalt = keep;
  }

  async #initDryRun(): Promise<void> {
    try {
      const period: SaltPeriod = 'month';
      const salt = new Uint8Array(32);
      crypto.getRandomValues(salt);
      await this.#hasher.setSalt(periodLabel(period, new Date(Date.now() - 32 * 86_400_000)), salt);
      await this.#hasher.setSalt(periodLabel(period), salt);
      this.#config = { appId: '0', mode: this.#opts.mode ?? 'privacy', saltPeriod: period, sampling: {} };
      this.#drainPendingSalt();
    } catch (error) {
      this.count('dry_run', error);
    }
  }

  /**
   * An event for a period this process has no salt for, which the schedule didn't see coming: the clock was stepped,
   * or the machine slept past a boundary. Ask soon rather than at the next hourly refresh.
   */
  #askForSalt(): void {
    if (Date.now() - this.#configAskedAt < SALT_ASK_INTERVAL_MS) return;
    this.#configAskedAt = Date.now();
    if (this.#opts.dryRun) this.#configLoading = this.#initDryRun();
    else this.#scheduleConfig(this.#random() * SALT_RETRY_MIN_MS);
  }

  #scheduleConfig(delayMs: number): void {
    clearTimeout(this.#configTimer as ReturnType<typeof setTimeout>);
    if (this.#closed) return;
    this.#configTimer = setTimeout(() => {
      this.#configLoading = this.#loadConfig();
    }, delayMs);
    unref(this.#configTimer);
  }

  async #loadConfig(): Promise<void> {
    if (this.#closed || this.#disabled) return;
    this.#configAskedAt = Date.now();
    try {
      const res = await this.#fetch(new URL('/v1/config', this.#opts.endpoint), {
        headers: { authorization: `Bearer ${this.#opts.apiKey}`, accept: 'application/json' },
        signal: this.#signal(),
      });
      if (res.status === 401 || res.status === 403) {
        await discard(res);
        this.#warn(
          'auth',
          `Shardlens: the collector rejected the API key (${res.status}). Check SHARDLENS_INGEST_KEY.`,
        );
        this.#scheduleConfig(AUTH_RETRY_MS);
        return;
      }
      if (!res.ok) {
        await discard(res);
        throw new Error(`config request failed with ${res.status}`);
      }
      const config = await this.#applyConfig(await readJson(res, MAX_CONFIG_BYTES));
      this.#configAttempt = 0;
      this.#collectorUp();
      const now = new Date();
      if (!this.#hasher.hasSalt(periodLabel(config.saltPeriod, now)) && this.#saltRetries < SALT_RETRIES) {
        // No salt yet for the period this clock is in, usually because it runs a little ahead of the collector's
        // around a period boundary. Events wait for it at most 60 seconds, so ask again soon, not in an hour.
        this.#saltRetries++;
        this.#scheduleConfig(SALT_RETRY_MIN_MS + this.#random() * SALT_RETRY_SPREAD_MS);
      } else {
        this.#saltRetries = 0;
        const next = nextPeriodStart(config.saltPeriod, now);
        const early = next - now.getTime() - NEXT_SALT_LEAD_MS;
        // Once the next period's salt is here, or it's too late to ask for it in time, ask again after the boundary.
        const delay =
          early > 0 && !this.#hasher.hasSalt(periodLabel(config.saltPeriod, new Date(next)))
            ? early + this.#random() * NEXT_SALT_SPREAD_MS
            : next - now.getTime() + this.#random() * 60_000;
        this.#scheduleConfig(Math.max(1_000, Math.min(delay, CONFIG_REFRESH_MS)));
      }
      this.#drainPendingSalt();
      if (this.#queue.size > 0) this.#scheduleFlush();
    } catch (error) {
      if (this.#closed) return; // given up by shutdown: not an outage
      this.count('config', error);
      this.#collectorDown(error);
      this.#scheduleConfig(backoffMs(this.#configAttempt++, this.#random));
    }
  }

  async #applyConfig(body: unknown): Promise<RemoteConfig> {
    const b = body as Partial<{
      v: number;
      appId: string;
      mode: string;
      saltPeriod: string;
      salts: { period: string; salt: string }[];
      sampling: Record<string, number>;
      serverTime: string;
    }>;
    const valid =
      b &&
      b.v === 1 &&
      typeof b.appId === 'string' &&
      SNOWFLAKE_RE.test(b.appId) &&
      (b.mode === 'privacy' || b.mode === 'audit') &&
      (b.saltPeriod === 'day' || b.saltPeriod === 'week' || b.saltPeriod === 'month') &&
      Array.isArray(b.salts) &&
      b.salts.every((s) => typeof s?.period === 'string' && typeof s.salt === 'string' && SALT_RE.test(s.salt));
    if (!valid) throw new Error('config response has an unexpected shape');
    // A salt the collector no longer serves has been destroyed there, and must not outlive it here.
    const served = new Set(b.salts!.map((s) => s.period));
    for (const label of this.#hasher.labels()) if (!served.has(label)) this.#hasher.deleteSalt(label);
    // Install the previous period first so the current one is kept as most recent.
    for (const s of [...b.salts!].reverse()) await this.#hasher.setSalt(s.period, base64UrlDecode(s.salt));
    const sampling: Record<string, number> = {};
    for (const [type, rate] of Object.entries(b.sampling ?? {})) {
      if (typeof rate === 'number' && rate > 0 && rate <= 1) sampling[type] = rate;
    }
    const config: RemoteConfig = {
      appId: b.appId!,
      mode: b.mode as DataMode,
      saltPeriod: b.saltPeriod as SaltPeriod,
      sampling,
    };
    const skew = typeof b.serverTime === 'string' ? Date.now() - Date.parse(b.serverTime) : 0;
    if (Math.abs(skew) > CLOCK_SKEW_WARN_MS) {
      this.#warn(
        'clock',
        `Shardlens: this machine's clock is ${Math.round(Math.abs(skew) / 1000)} s ${skew > 0 ? 'ahead of' : 'behind'} the collector's. Events near the start of a salt period may wait or be dropped; sync the clock (NTP).`,
      );
    }
    if (this.#opts.mode === 'audit' && config.mode !== 'audit') {
      this.#warn(
        'mode',
        'Shardlens: the SDK is set to audit mode but the collector is in privacy mode; sending privacy-mode data only.',
      );
    }
    this.#config = config;
    return config;
  }

  async #runFlush(): Promise<void> {
    // After shutdown every request is aborted at once: trying would only report an outage that isn't one.
    if (this.#disabled || this.#stopped) return;
    this.#drainPendingSalt();
    // The collector is unreachable (no settings yet, or backing off): move what memory can't comfortably hold to the
    // spool.
    if (!this.#config || Date.now() < this.#retryAt || !(await this.#replaySpool())) {
      await this.#spill(false);
      return;
    }
    for (let i = 0; i < MAX_BATCHES_PER_FLUSH && this.#queue.size > 0; i++) {
      if (Date.now() < this.#retryAt) return;
      if (!(await this.#sendBatch(this.#queue.take(this.#batchCap)))) {
        await this.#spill(false);
        return;
      }
    }
  }

  /**
   * Writes queued events to the spool: everything (on shutdown), or whatever is above half the queue's capacity (during
   * an outage, before memory would start dropping). Most important events go first. Identities never reach disk.
   */
  async #spill(everything: boolean): Promise<void> {
    const spool = this.#spool;
    if (!spool) return;
    const keep = everything ? 0 : Math.floor(this.#maxQueue / 2);
    // During an outage every enqueue can trigger a flush: waiting for a fair-sized batch keeps the spool from filling
    // with batches of one or two events, each of which would later be a request of its own.
    const least = everything ? 1 : Math.max(1, Math.min(this.#batchCap, Math.floor((this.#maxQueue - keep) / 2)));
    if (this.#queue.size - keep < least) return;
    while (this.#queue.size > keep) {
      const items = this.#queue.take(Math.min(this.#batchCap, this.#queue.size - keep));
      const events = items.filter((i) => !this.#isErased(i.item)).map((i) => stripIdentifying(i.item));
      let stored = events.length === 0;
      try {
        stored ||= await spool.write(events);
      } catch (error) {
        this.count('spool_write', error);
      }
      if (stored) this.#spooled += events.length;
      else if (everything) this.#extraDropped.spool_full += events.length;
      else {
        this.#queue.requeue(items);
        return;
      }
    }
  }

  /**
   * Sends spooled batches, oldest first, before anything new. Returns false when the collector is still unavailable.
   * A batch is deleted only once the collector accepted it; replays are safe because the collector dedupes by ID.
   */
  async #replaySpool(): Promise<boolean> {
    const spool = this.#spool;
    if (!spool) return true;
    for (let i = 0; i < MAX_BATCHES_PER_FLUSH; i++) {
      let batch: { id: string; events: WireEvent[] } | undefined;
      try {
        batch = await spool.next();
      } catch (error) {
        this.count('spool_read', error);
        return true;
      }
      if (!batch) return true;
      // Whatever a spool hands back, a batch that can't be sent is dropped, or it would hold up every later one.
      const events = Array.isArray(batch.events) ? batch.events.filter((event) => !this.#isErased(event)) : [];
      let result: SendResult = 0;
      try {
        if (events.length > 0) result = await this.#send(this.#encode([...events, this.#health()]), events.length);
      } catch (error) {
        this.count('send', error);
        result = 'refused';
      }
      if (result === 'retry' || result === 'audit_off') return false;
      let lost = typeof result === 'number' ? result : events.length;
      if (typeof result === 'number') this.#replayed += events.length - result;
      else if (result === 'too_large' && events.length > 1) {
        // A proxy in front of the collector may take less than it does: put the batch back in two halves.
        const half = Math.ceil(events.length / 2);
        try {
          if (await spool.write(events.slice(0, half))) lost -= half;
          if (await spool.write(events.slice(half))) lost -= events.length - half;
        } catch (error) {
          this.count('spool_write', error);
        }
      }
      this.#extraDropped.invalid += lost;
      try {
        await spool.ack(batch.id);
      } catch (error) {
        this.count('spool_ack', error);
        return true;
      }
    }
    return true;
  }

  #health(): WireEvent {
    const s = this.stats();
    return {
      id: uuidv7(),
      ts: Date.now(),
      type: 'sdk_health',
      queueDepth: s.queueDepth,
      dropped: s.dropped,
      failedFlushes: s.failedFlushes,
      internalErrors: s.internalErrors,
    } as WireEvent;
  }

  /** A batch's envelope as UTF-8 JSON. Throws if an event can't be serialised. */
  #encode(events: WireEvent[]): Uint8Array {
    const config = this.#config!;
    let source: SourceInfo = { shards: [], instance: 'unknown' };
    try {
      const s = this.#opts.source?.();
      // A NUL in the envelope would make the collector refuse the whole batch.
      if (typeof s === 'object' && s !== null) source = { ...s, instance: cutText(String(s.instance), 128) };
    } catch (error) {
      this.count('source', error);
    }
    const envelope = {
      v: 1,
      mode: this.mode,
      sdk: this.#opts.sdk,
      app: {
        id: config.appId,
        env: this.#opts.environment,
        ...(this.#opts.release ? { release: this.#opts.release } : {}),
      },
      source,
      sentAt: new Date().toISOString(),
      events,
    };
    return new TextEncoder().encode(JSON.stringify(envelope));
  }

  /**
   * Sends one batch from the queue, putting back what should be tried again. Returns false when sending must wait for
   * the backoff.
   */
  async #sendBatch(batch: QueuedItem<E>[]): Promise<boolean> {
    let items = batch.filter((i) => !this.#isErased(i.item));
    let events: WireEvent[] = [];
    let body: Uint8Array | undefined;
    try {
      while (items.length > 0) {
        const privacy = this.mode !== 'audit';
        events = items.map((i) => (privacy ? stripIdentifying(i.item) : i.item));
        events.push(this.#health());
        body = this.#encode(events);
        if (body.byteLength <= MAX_BATCH_BYTES || items.length === 1) break;
        const half = Math.ceil(items.length / 2);
        this.#queue.requeue(items.slice(half));
        items = items.slice(0, half);
      }
    } catch (error) {
      // Nothing was sent: count the events rather than lose them without a trace or retry them forever.
      this.count('send', error);
      this.#extraDropped.invalid += items.length;
      return true;
    }
    if (!body) return true;

    if (this.#opts.dryRun) {
      // A console is not encrypted storage: audit-mode identities are shown as present, never printed.
      for (const event of events) {
        const shown = 'actor' in event ? { ...stripIdentifying(event), actor: '[hidden]' } : event;
        this.#log('info', `[shardlens dry-run] ${JSON.stringify(shown)}`);
      }
      return true;
    }

    const result = await this.#send(body, items.length);
    if (typeof result === 'number') {
      this.#extraDropped.invalid += result;
      this.#batchCap = Math.min(this.#opts.maxBatchSize, this.#batchCap * 2);
      return true;
    }
    if (result === 'refused' || (result === 'too_large' && items.length === 1)) {
      // A batch the collector will never accept: drop it rather than retry it forever.
      this.#extraDropped.invalid += items.length;
      return true;
    }
    if (result === 'too_large') this.#batchCap = Math.max(1, Math.floor(items.length / 2));
    this.#queue.requeue(items);
    return result !== 'retry';
  }

  /** POSTs one batch of `count` events (plus the health event) to the collector. Never throws for a failed request. */
  async #send(body: Uint8Array, count: number): Promise<SendResult> {
    let res: Response;
    try {
      res = await this.#fetch(new URL('/v1/ingest', this.#opts.endpoint), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.#opts.apiKey}`,
          'content-type': 'application/json',
          'content-encoding': 'gzip',
        },
        body: (await gzip(body)) as Uint8Array<ArrayBuffer>,
        signal: this.#signal(),
      });
    } catch (error) {
      // Given up at the end of shutdown: not an outage.
      if (!this.#abort.signal.aborted) {
        this.count('network', error);
        this.#collectorDown(error);
      }
      return this.#retryLater(null);
    }

    const status = res.status;
    if (status >= 200 && status < 300) {
      const reply = (await readJson(res, MAX_REPLY_BYTES)) as { rejected?: unknown } | undefined;
      this.#attempt = 0;
      this.#collectorUp();
      return rejectedCount(reply?.rejected, count);
    }
    if (status === 400) {
      const reply = (await readJson(res, MAX_REPLY_BYTES)) as { error?: unknown } | undefined;
      if (reply?.error === 'audit_mode_disabled') {
        this.#auditSwitchedOff();
        return 'audit_off';
      }
      this.#warn('invalid', 'Shardlens: the collector rejected a batch as invalid; it was dropped.');
      return 'refused';
    }
    await discard(res);
    if (status === 413) return 'too_large';
    if (status === 401 || status === 403) {
      this.#warn('auth', `Shardlens: the collector rejected the API key (${status}). Sending is paused.`);
      this.#failedFlushes++;
      this.#retryAt = Date.now() + AUTH_RETRY_MS;
      return 'retry';
    }
    if (status !== 429 && status !== 503) {
      this.count(`http_${status >= 500 ? '5xx' : status}`);
      this.#collectorDown(`HTTP ${status}`);
    }
    return this.#retryLater(res.headers.get('retry-after'));
  }

  #retryLater(retryAfter: string | null): 'retry' {
    this.#failedFlushes++;
    this.#retryAt = Date.now() + this.#backoff(retryAfter);
    return 'retry';
  }
}
