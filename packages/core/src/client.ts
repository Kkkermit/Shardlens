import type { ShardlensExporter } from './exporter.js';
import { periodLabel, type SaltPeriod, UserHasher } from './hash.js';
import { redactSecrets } from './normalise.js';
import { BoundedQueue, PRIORITIES, type Priority, type QueuedItem } from './queue.js';
import type { EventSpool } from './spool.js';
import { backoffMs, gzipJson, isAllowedEndpoint } from './transport.js';
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
const MAX_BATCHES_PER_FLUSH = 20;
const SALT_RE = /^[A-Za-z0-9_-]{43}$/;
const SNOWFLAKE_RE = /^\d{17,20}$/;

function unref(timer: unknown): void {
  (timer as { unref?: () => void } | undefined)?.unref?.();
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

/** Parses `Retry-After` (seconds or HTTP date) into milliseconds from now. */
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
  #flushScheduled = false;
  #flushTimer: unknown;
  #configTimer: unknown;
  #closed = false;
  #disabled = false;
  /** No collector configured: events only go to exporters. */
  readonly #localOnly: boolean;
  readonly #exporters: readonly ShardlensExporter[];
  #configLoading: Promise<void> | undefined;
  /** Hashing in progress (it is async: Web Crypto). */
  #inflight = 0;
  #idleWaiters: (() => void)[] = [];
  readonly #maxQueue: number;
  #spooled = 0;
  #replayed = 0;

  constructor(options: ClientOptions) {
    this.#opts = {
      ...options,
      flushIntervalMs: Math.max(250, options.flushIntervalMs ?? 5_000),
      maxBatchSize: Math.min(MAX_BATCH_EVENTS - 1, Math.max(1, options.maxBatchSize ?? MAX_BATCH_EVENTS - 1)),
      environment: (options.environment ?? 'production').slice(0, 32),
    };
    this.#batchCap = this.#opts.maxBatchSize;
    this.#maxQueue = Math.max(1, options.maxQueueSize ?? 10_000);
    this.#queue = new BoundedQueue<E>(this.#maxQueue);
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#random = options.random ?? Math.random;
    this.#logger = options.logger ?? { warn: (m) => console.warn(m), info: (m) => console.info(m) };
    this.#exporters = [...(options.exporters ?? [])];
    this.#localOnly = !options.dryRun && !options.endpoint && !options.apiKey;

    if (this.#localOnly) {
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
    if (options.dryRun) void this.#initDryRun();
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
      if (this.#localOnly) return;
      const sampled = this.#sample(event);
      if (!sampled) return;
      this.#queue.push(sampled, priority);
      if (this.#queue.size >= this.#batchCap) this.#scheduleFlush();
    } catch (error) {
      this.count('enqueue', error);
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
      if (this.#localOnly) return;
      const label = this.#config ? periodLabel(this.#config.saltPeriod, new Date(ts)) : undefined;
      if (label && this.#hasher.hasSalt(label)) {
        void this.#hashAndQueue({ userId, ts, priority, build, addedAt: Date.now() }, label);
        return;
      }
      if (this.#pendingSalt.length >= PENDING_SALT_MAX) {
        this.#dropForSalt();
        return;
      }
      this.#pendingSalt.push({ userId, ts, priority, build, addedAt: Date.now() });
    } catch (error) {
      this.count('enqueue', error);
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
    if (!this.#config || this.#disabled || this.#opts.dryRun) return undefined;
    try {
      // Send what was recorded a moment ago first, or it would be stored after the erasure and survive it.
      await this.idle();
      await this.flush();
      const hashes: string[] = [];
      for (const label of this.#hasher.labels()) {
        const h = await this.#hasher.hash(userId, label);
        if (h) hashes.push(h);
      }
      const res = await this.#fetch(new URL('/v1/privacy/erase', this.#opts.endpoint), {
        method: 'POST',
        headers: { authorization: `Bearer ${this.#opts.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ userHashes: hashes, ...(this.mode === 'audit' ? { userId } : {}) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        this.count(`erase_${res.status}`);
        return undefined;
      }
      const body = (await res.json()) as { erased?: unknown };
      return { erased: typeof body.erased === 'number' ? body.erased : 0 };
    } catch (error) {
      this.count('erase', error);
      return undefined;
    }
  }

  /** Increments an internal error counter and notifies listeners. For adapters; never throws. */
  count(name: string, error?: unknown): void {
    this.#internalErrors.set(name, (this.#internalErrors.get(name) ?? 0) + 1);
    for (const listener of this.#listeners) {
      try {
        listener(name, error);
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
    let timer: unknown;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      unref(timer);
    });
    const work = (async () => {
      await this.#configLoading;
      while (this.#inflight > 0) await new Promise<void>((resolve) => this.#idleWaiters.push(resolve));
    })().catch((error: unknown) => this.count('idle', error));
    await Promise.race([work, timeout]);
    clearTimeout(timer as ReturnType<typeof setTimeout>);
  }

  /** Sends queued events now. Concurrent calls share one flush. Never throws. */
  flush(): Promise<void> {
    if (!this.#flushing) {
      this.#flushing = this.#runFlush()
        .catch((error: unknown) => this.count('flush', error))
        .finally(() => {
          this.#flushing = undefined;
        });
    }
    return this.#flushing;
  }

  /**
   * Stops timers and flushes what is queued, giving up after `timeoutMs`. The SDK never installs signal handlers;
   * call this from your own shutdown code. Never throws.
   */
  async shutdown({ timeoutMs = 2_000 }: FlushOptions = {}): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#flushTimer as ReturnType<typeof setInterval>);
    clearTimeout(this.#configTimer as ReturnType<typeof setTimeout>);
    const deadline = Date.now() + timeoutMs;
    let timer: unknown;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      unref(timer);
    });
    const drain = (async () => {
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
    await Promise.race([Promise.all([drain, exporters]), timeout]);
    clearTimeout(timer as ReturnType<typeof setTimeout>);
    // A send can hang past the deadline; the events still in memory go to the spool (local, quick) regardless.
    if (this.#opts.spool && this.#queue.size > 0) {
      let spillTimer: unknown;
      await Promise.race([
        this.#spill(true).catch((error: unknown) => this.count('shutdown', error)),
        new Promise<void>((resolve) => {
          spillTimer = setTimeout(resolve, 1_000);
          unref(spillTimer);
        }),
      ]);
      clearTimeout(spillTimer as ReturnType<typeof setTimeout>);
    }
  }

  #warn(key: string, message: string): void {
    if (this.#warned.has(key)) return;
    this.#warned.add(key);
    try {
      this.#logger.warn(redactSecrets(message));
    } catch {
      // ignore logger failures
    }
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
      'Shardlens: events recorded before the collector was reachable were dropped after 60 seconds (see stats().dropped.salt_missing).',
    );
  }

  /** One warning per outage, not one per failed request. */
  #collectorDown(reason: unknown): void {
    const why = (reason instanceof Error ? reason.message : String(reason)).slice(0, 120);
    this.#warn(
      'unreachable',
      `Shardlens: can't reach the collector at ${this.#collector} (${why}). Retrying; events wait in memory.`,
    );
  }

  #collectorUp(): void {
    if (!this.#warned.delete('unreachable')) return;
    try {
      this.#logger.info?.(`Shardlens: connected to the collector at ${this.#collector}.`);
    } catch {
      // ignore logger failures
    }
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
    if (rate === undefined || !(rate > 0 && rate < 1)) return event;
    if (this.#random() >= rate) return undefined;
    return { ...event, weight: (event.weight ?? 1) / rate };
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
    if (this.#closed) {
      this.#extraDropped.closed++;
      return;
    }
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
    try {
      const res = await this.#fetch(new URL('/v1/config', this.#opts.endpoint), {
        headers: { authorization: `Bearer ${this.#opts.apiKey}`, accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 401 || res.status === 403) {
        await res.body?.cancel();
        this.#warn(
          'auth',
          `Shardlens: the collector rejected the API key (${res.status}). Check SHARDLENS_INGEST_KEY.`,
        );
        this.#scheduleConfig(AUTH_RETRY_MS);
        return;
      }
      if (!res.ok) throw new Error(`config request failed with ${res.status}`);
      const config = await this.#applyConfig(await res.json());
      this.#configAttempt = 0;
      this.#collectorUp();
      const now = new Date();
      const boundary = nextPeriodStart(config.saltPeriod, now) - now.getTime() + this.#random() * 60_000;
      this.#scheduleConfig(Math.max(1_000, Math.min(boundary, CONFIG_REFRESH_MS)));
      this.#drainPendingSalt();
      if (this.#queue.size > 0) this.#scheduleFlush();
    } catch (error) {
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
    this.#drainPendingSalt();
    if (this.#disabled || !this.#config) return;
    // The collector is unreachable (backing off): move what memory can't comfortably hold to the spool.
    if (Date.now() < this.#retryAt || !(await this.#replaySpool())) {
      await this.#spill(false);
      return;
    }
    for (let i = 0; i < MAX_BATCHES_PER_FLUSH && this.#queue.size > 0; i++) {
      if (Date.now() < this.#retryAt) return;
      const sent = await this.#sendBatch(this.#queue.take(this.#batchCap));
      if (!sent) {
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
    const spool = this.#opts.spool;
    if (!spool || this.#localOnly) return;
    const keep = everything ? 0 : Math.floor(this.#maxQueue / 2);
    while (this.#queue.size > keep) {
      const items = this.#queue.take(Math.min(this.#batchCap, this.#queue.size - keep));
      let stored = false;
      try {
        stored = await spool.write(items.map((i) => stripIdentifying(i.item)));
      } catch (error) {
        this.count('spool_write', error);
      }
      if (stored) {
        this.#spooled += items.length;
        continue;
      }
      if (everything) {
        this.#extraDropped.spool_full += items.length;
        continue;
      }
      this.#queue.requeue(items);
      return;
    }
  }

  /**
   * Sends spooled batches, oldest first, before anything new. Returns false when the collector is still unavailable.
   * A batch is deleted only once the collector accepted it; replays are safe because the collector dedupes by ID.
   */
  async #replaySpool(): Promise<boolean> {
    const spool = this.#opts.spool;
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
      const outcome = await this.#postSpooled(batch.events);
      if (outcome === 'retry') return false;
      if (outcome === 'ok') this.#replayed += batch.events.length;
      else this.#extraDropped.invalid += batch.events.length;
      try {
        await spool.ack(batch.id);
      } catch (error) {
        this.count('spool_ack', error);
        return true;
      }
    }
    return true;
  }

  async #postSpooled(events: WireEvent[]): Promise<'ok' | 'drop' | 'retry'> {
    let res: Response;
    try {
      res = await this.#post(this.#envelope([...events, this.#health()]));
    } catch (error) {
      this.count('network', error);
      this.#collectorDown(error);
      this.#failedFlushes++;
      this.#retryAt = Date.now() + backoffMs(this.#attempt++, this.#random);
      return 'retry';
    }
    const status = res.status;
    const retryAfter = res.headers.get('retry-after');
    if (status === 400) {
      const reply = (await res.json().catch(() => undefined)) as { error?: unknown } | undefined;
      if (reply?.error === 'audit_mode_disabled') {
        this.#auditSwitchedOff();
        return 'retry';
      }
      // A batch the collector will never accept: drop it rather than block the spool.
      return 'drop';
    }
    await res.body?.cancel().catch(() => undefined);
    if (status >= 200 && status < 300) {
      this.#attempt = 0;
      return 'ok';
    }
    if (status === 413) return 'drop';
    this.#failedFlushes++;
    const wait =
      status === 401 || status === 403
        ? AUTH_RETRY_MS
        : (retryAfterMs(retryAfter, Date.now()) ?? backoffMs(this.#attempt++, this.#random));
    this.#retryAt = Date.now() + wait;
    return 'retry';
  }

  /** POSTs one gzipped envelope to the collector. Rejects on network errors and timeouts. */
  async #post(envelope: Record<string, unknown>): Promise<Response> {
    return this.#fetch(new URL('/v1/ingest', this.#opts.endpoint), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.#opts.apiKey}`,
        'content-type': 'application/json',
        'content-encoding': 'gzip',
      },
      body: (await gzipJson(envelope)) as Uint8Array<ArrayBuffer>,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
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

  #envelope(events: WireEvent[]): Record<string, unknown> {
    const config = this.#config!;
    let source: SourceInfo = { shards: [], instance: 'unknown' };
    try {
      if (this.#opts.source) source = this.#opts.source();
    } catch (error) {
      this.count('source', error);
    }
    return {
      v: 1,
      mode: this.mode,
      sdk: this.#opts.sdk,
      app: {
        id: config.appId,
        env: this.#opts.environment,
        ...(this.#opts.release ? { release: this.#opts.release.slice(0, 64) } : {}),
      },
      source: { ...source, instance: source.instance.slice(0, 128) },
      sentAt: new Date().toISOString(),
      events,
    };
  }

  /** Sends one batch. Returns true when the batch left the queue for good (sent, or dropped as invalid). */
  async #sendBatch(items: QueuedItem<E>[]): Promise<boolean> {
    if (items.length === 0) return true;
    const privacy = this.mode !== 'audit';
    const events: WireEvent[] = items.map((i) => (privacy ? stripIdentifying(i.item) : i.item));
    events.push(this.#health());
    const envelope = this.#envelope(events);
    const json = JSON.stringify(envelope);

    if (new TextEncoder().encode(json).byteLength > MAX_BATCH_BYTES && items.length > 1) {
      const half = Math.ceil(items.length / 2);
      this.#queue.requeue(items.slice(half));
      return this.#sendBatch(items.slice(0, half));
    }

    if (this.#opts.dryRun) {
      for (const event of events) this.#logger.info?.(`[shardlens dry-run] ${redactSecrets(JSON.stringify(event))}`);
      return true;
    }

    let res: Response;
    try {
      res = await this.#post(envelope);
    } catch (error) {
      this.count('network', error);
      this.#collectorDown(error);
      return this.#retryLater(items);
    }

    const status = res.status;
    if (status >= 200 && status < 300) {
      const reply = (await res.json().catch(() => undefined)) as { rejected?: unknown } | undefined;
      if (Array.isArray(reply?.rejected)) this.#extraDropped.invalid += reply.rejected.length;
      this.#attempt = 0;
      this.#collectorUp();
      this.#batchCap = Math.min(this.#opts.maxBatchSize, this.#batchCap * 2);
      return true;
    }

    if (status === 400) {
      const reply = (await res.json().catch(() => undefined)) as
        { error?: unknown; rejected?: { index?: unknown }[] } | undefined;
      if (reply?.error === 'audit_mode_disabled') {
        this.#auditSwitchedOff();
        this.#queue.requeue(items);
        return true;
      }
      const bad = new Set(
        Array.isArray(reply?.rejected) ? reply.rejected.map((r) => r.index).filter((i) => typeof i === 'number') : [],
      );
      if (bad.size === 0) {
        this.#extraDropped.invalid += items.length;
        this.#warn('invalid', 'Shardlens: the collector rejected a batch as invalid; it was dropped.');
        return true;
      }
      this.#extraDropped.invalid += [...bad].filter((i) => (i as number) < items.length).length;
      this.#queue.requeue(items.filter((_, i) => !bad.has(i)));
      return true;
    }

    await res.body?.cancel().catch(() => undefined);
    if (status === 401 || status === 403) {
      this.#warn('auth', `Shardlens: the collector rejected the API key (${status}). Sending is paused.`);
      this.#failedFlushes++;
      this.#queue.requeue(items);
      this.#retryAt = Date.now() + AUTH_RETRY_MS;
      return false;
    }
    if (status === 413) {
      if (items.length === 1) {
        // One event the collector will never accept: drop it rather than retry forever.
        this.#extraDropped.invalid++;
        return true;
      }
      this.#batchCap = Math.max(1, Math.floor(items.length / 2));
      this.#queue.requeue(items);
      return true;
    }
    if (status === 429 || status === 503) {
      const wait = retryAfterMs(res.headers.get('retry-after'), Date.now());
      this.#failedFlushes++;
      this.#queue.requeue(items);
      this.#retryAt = Date.now() + (wait ?? backoffMs(this.#attempt++, this.#random));
      return false;
    }
    this.count(`http_${status >= 500 ? '5xx' : status}`);
    this.#collectorDown(`HTTP ${status}`);
    return this.#retryLater(items);
  }

  #retryLater(items: QueuedItem<E>[]): false {
    this.#failedFlushes++;
    this.#queue.requeue(items);
    this.#retryAt = Date.now() + backoffMs(this.#attempt++, this.#random);
    return false;
  }
}
