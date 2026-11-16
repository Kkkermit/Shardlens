import { answerError, ShardlensClientError } from './errors.js';

/** Options of {@link createShardlensClient}. */
export interface ShardlensClientOptions {
  /** Your collector's URL. HTTPS, or HTTP to localhost only. */
  url: string;
  /**
   * A read key (`slk_read_…`) or, to read the activity log as well, an activity key (`slk_activity_…`). Keep it on
   * your server: a key in a browser can be read by every visitor.
   */
  key: string;
  /** How long a request may take, and how long a live stream may take to connect, in milliseconds. Default 10,000. */
  timeoutMs?: number | undefined;
  /** The `fetch` to send requests with. Default: the global one. */
  fetch?: typeof fetch | undefined;
}

/** Options of one call. */
export interface RequestOptions {
  /**
   * Aborting ends the call. A request then rejects with the signal's reason, as `fetch` does; a live stream just
   * ends.
   */
  signal?: AbortSignal | undefined;
}

const DEFAULT_TIMEOUT_MS = 10_000;
/** The longest delay a timer takes. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;
/** Plain HTTP is allowed to these only, as in the SDK. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
/** `slk_<scope>_` and 32 random bytes in base64url: the collector's key format. */
const READER_KEY = /^slk_(read|activity)_[\w-]{43}$/;

function invalid(message: string): ShardlensClientError {
  return new ShardlensClientError(message, { status: 0, code: 'invalid_options' });
}

/**
 * The collector's address, under the SDK's rule for `endpoint`. Messages never repeat the value: a key pasted into
 * `url` by mistake must not end up in a log.
 */
function collectorUrl(url: unknown): URL {
  let parsed: URL | undefined;
  try {
    parsed = new URL(String(url));
  } catch {
    // reported below, with every other value that isn't a collector's address
  }
  if (parsed && (parsed.username || parsed.password)) throw invalid('url must not contain a user name or password');
  const allowed =
    parsed?.protocol === 'https:' || (parsed?.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname));
  if (!parsed || !allowed) throw invalid('url must be https:// (or http://localhost)');
  return parsed;
}

function readerKey(key: unknown): string {
  if (typeof key !== 'string' || key === '') {
    throw invalid('key is missing: pass a read key (slk_read_…) or an activity key (slk_activity_…)');
  }
  if (key.startsWith('slk_ingest_')) {
    throw invalid(
      'key is an ingest key, which can only send events: use a read key (slk_read_…) or an activity key (slk_activity_…)',
    );
  }
  if (!READER_KEY.test(key)) {
    throw invalid(
      'key must be a read key (slk_read_ and 43 more characters) or an activity key (slk_activity_ and 43 more characters)',
    );
  }
  return key;
}

/** Makes `controller` abort when `source` does. Returns how to stop following it. */
function follow(controller: AbortController, source: AbortSignal | undefined): () => void {
  if (!source) return () => undefined;
  const abort = () => controller.abort(source.reason);
  if (source.aborted) abort();
  else source.addEventListener('abort', abort, { once: true });
  return () => source.removeEventListener('abort', abort);
}

/** An open response body. */
export interface OpenStream {
  body: ReadableStream<Uint8Array>;
  /** Closes the connection. */
  close(): void;
}

/** Requests to one collector with one key. */
export interface Transport {
  /** A JSON request: `GET`, or `POST` with a body. Resolves with the parsed answer. */
  request<T>(path: string, init?: { body?: unknown; signal?: AbortSignal | undefined }): Promise<T>;
  /** A `GET` whose answer is read as a stream. The time limit covers connecting only. */
  open(path: string, signal: AbortSignal | undefined): Promise<OpenStream>;
  /** The error for a request or stream that broke off without an answer. */
  unreachable(cause: unknown): ShardlensClientError;
}

/** Checks the options, and throws for those the client can't work with before any request is made. */
export function createTransport(options: ShardlensClientOptions): Transport {
  const base = collectorUrl(options?.url);
  const key = readerKey(options?.key);
  const asked = options.timeoutMs;
  const timeoutMs =
    typeof asked === 'number' && asked > 0 ? Math.min(Math.ceil(asked), MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
  // Looked up on every call, so a `fetch` patched in later (a test, an instrumentation library) is the one used.
  const send: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const authorization = `Bearer ${key}`;

  const unreachable = (cause: unknown) =>
    new ShardlensClientError(`Could not reach the collector at ${base.origin}.`, { status: 0, code: 'network', cause });
  const noAnswer = (cause: unknown, timedOut: boolean) =>
    timedOut
      ? new ShardlensClientError(`The collector at ${base.origin} did not answer within ${timeoutMs} ms.`, {
          status: 0,
          code: 'timeout',
          cause,
        })
      : unreachable(cause);

  return {
    unreachable,

    async request<T>(path: string, init: { body?: unknown; signal?: AbortSignal | undefined } = {}): Promise<T> {
      const controller = new AbortController();
      const timeout = AbortSignal.timeout(timeoutMs);
      const unfollow = [follow(controller, timeout), follow(controller, init.signal)];
      try {
        const res = await send(new URL(path, base), {
          method: init.body === undefined ? 'GET' : 'POST',
          headers: {
            authorization,
            accept: 'application/json',
            ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
          signal: controller.signal,
        });
        if (!res.ok) throw await answerError(res);
        const text = await res.text();
        try {
          return JSON.parse(text) as T;
        } catch {
          // A 2xx page that isn't JSON: `url` points at a website or a proxy's sign-in page, not at the collector.
          throw new ShardlensClientError(`The answer from ${base.origin} is not a Shardlens collector's.`, {
            status: res.status,
            code: 'invalid_response',
          });
        }
      } catch (error) {
        // The caller's own abort is passed on as `fetch` reports it.
        if (error instanceof ShardlensClientError || init.signal?.aborted) throw error;
        throw noAnswer(error, timeout.aborted);
      } finally {
        for (const stop of unfollow) stop();
      }
    },

    async open(path: string, signal: AbortSignal | undefined): Promise<OpenStream> {
      const controller = new AbortController();
      const timeout = AbortSignal.timeout(timeoutMs);
      const stopClock = follow(controller, timeout);
      const unfollow = follow(controller, signal);
      const close = () => {
        unfollow();
        controller.abort();
      };
      try {
        const res = await send(new URL(path, base), {
          headers: { authorization, accept: 'text/event-stream' },
          signal: controller.signal,
        });
        if (!res.ok) throw await answerError(res);
        if (!res.body) throw unreachable(undefined);
        return { body: res.body, close };
      } catch (error) {
        close();
        if (error instanceof ShardlensClientError || signal?.aborted) throw error;
        throw noAnswer(error, timeout.aborted);
      } finally {
        stopClock();
      }
    },
  };
}
