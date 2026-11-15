import { newHistogram, observe, uuidv7 } from '@shardlens/core';
import type { EventInput } from '@shardlens/schema';
import { type Client, RESTEvents } from 'discord.js';
import type { InteractionTracker } from './interactions.js';
import { clamped, clampedInt, normaliseRoute } from './util.js';

type RestWindowInput = Extract<EventInput, { type: 'rest_window' }>;
type RestRow = RestWindowInput['rows'][number];

/** Bucketed route @discordjs/rest uses for every initial interaction response. */
const CALLBACK_ROUTE = '/interactions/:id/:token/callback';
/** Interaction callback type for "open a modal". */
const MODAL = 9;
/** The wire format's limit per `rest_window`: one row more and the collector rejects the whole window. */
const MAX_ROWS = 2_000;
/** Rows held back for `(other)`, so calls on routes past the limit still count under their method and status. */
const OVERFLOW_ROWS = 100;
const OVERFLOW_ROUTE = '(other)';
/** The wire format's cap on a rate limit's waits: 30 days, in milliseconds. */
const MAX_WAIT_MS = 2_592_000_000;

type Rest = Client['rest'];
type MakeRequest = Rest['options']['makeRequest'];
type ResponseListener = (...args: Parameters<Parameters<Rest['on']>[1]>) => void;

/** A real WHATWG `Response`. Only these are true clones that are safe to read or cancel. */
function isWebResponse(value: unknown): value is Response {
  return typeof Response !== 'undefined' && value instanceof Response;
}

/**
 * Where each Shardlens `makeRequest` wrapper sends calls on to. Kept outside the wrapper so a wrapper that is no longer
 * on top (a second Shardlens on the same client installed after it) can still be spliced out of the chain.
 */
const nextRequest = new WeakMap<MakeRequest, { next: MakeRequest }>();

export interface RestHooks {
  /** Builds the `rest_window` event for the period since the last drain, or `undefined` if nothing happened. */
  drain(): RestWindowInput | undefined;
  uninstall(): void;
}

/**
 * REST instrumentation through public hooks only: the `response`, `rateLimited` and `invalidRequestWarning` events,
 * plus a wrapper around the documented `makeRequest` option for latency.
 *
 * Safety: in Node, @discordjs/rest's default (undici) strategy passes the listener a *shallow copy* whose body is the
 * same stream discord.js reads. Reading or cancelling it would break the bot, so bodies are only touched when the
 * argument is a genuine `Response` clone (global `fetch`, Bun, Deno). See ADR 0009.
 */
export function installRestHooks(
  client: Client,
  opts: {
    tracker: InteractionTracker | undefined;
    enqueue: (event: EventInput, priority: 0 | 1 | 2 | 3) => void;
    count: (name: string, error?: unknown) => void;
    safe: <A extends unknown[]>(name: string, fn: (...args: A) => void | Promise<void>) => (...args: A) => void;
  },
): RestHooks {
  const rest = client.rest;
  const timings = new WeakMap<object, number>();
  let rows = new Map<string, RestRow>();
  let invalid = { count401: 0, count403: 0, count429: 0, shared429: 0 };
  let windowStart = Date.now();

  const record = (method: string, route: string, status: number, retries: number, ms: number | undefined) => {
    let row = rows.get(`${method} ${route} ${status}`);
    if (!row) {
      const kept = rows.size < MAX_ROWS - OVERFLOW_ROWS ? route : OVERFLOW_ROUTE;
      const key = `${method} ${kept} ${status}`;
      row = rows.get(key);
      if (!row) {
        if (rows.size >= MAX_ROWS) {
          opts.count('rest_rows_full');
          return;
        }
        row = { method, route: kept, status, count: 0, retries: 0, latency: newHistogram() };
        rows.set(key, row);
      }
    }
    row.count++;
    row.retries += retries;
    if (ms !== undefined) observe(row.latency, ms);
  };

  const onResponse: ResponseListener = opts.safe('restResponse', async (request, response) => {
    const status = response.status;
    const method = String(request.method ?? 'GET')
      .toUpperCase()
      .slice(0, 8);
    const headersRef = request.options?.headers;
    const ms = headersRef && typeof headersRef === 'object' ? timings.get(headersRef) : undefined;
    record(method, normaliseRoute(request.route), status, request.retries ?? 0, ms);

    if (status === 401) invalid.count401++;
    else if (status === 403) invalid.count403++;
    else if (status === 429) {
      if (response.headers.get('x-ratelimit-scope') === 'shared') invalid.shared429++;
      else invalid.count429++;
    }

    const webClone = isWebResponse(response) ? response : undefined;
    // @discordjs/rest gives every `response` listener the same clone, so it is the bot's too when the bot listens.
    const shared = rest.listenerCount(RESTEvents.Response) > 1;
    let bodyHandled = false;

    if (request.route === CALLBACK_ROUTE && opts.tracker) {
      // The raw path holds the interaction token: read only the ID from it, in memory, and never store the path.
      const id = /^\/interactions\/(\d{17,20})\//.exec(String(request.path))?.[1];
      if (id) {
        const body = request.data?.body as
          { type?: unknown; data?: { flags?: unknown; custom_id?: unknown } } | undefined;
        const type = typeof body?.type === 'number' ? body.type : undefined;
        const flags = typeof body?.data?.flags === 'number' ? body.data.flags : 0;
        const created = Number((BigInt(id) >> 22n) + 1420070400000n);
        const ackMs = Math.max(0, Date.now() - created);
        if (status >= 200 && status < 300) {
          opts.tracker.responded(id, {
            outcome: 'ok',
            ackMs,
            ...(type !== undefined ? { responseType: type } : {}),
            deferred: type === 5 || type === 6,
            ephemeral: (flags & 64) === 64,
            ...(type === MODAL && typeof body?.data?.custom_id === 'string'
              ? { modalCustomId: body.data.custom_id }
              : {}),
          });
        } else {
          let code: number | undefined;
          if (webClone) {
            bodyHandled = true;
            // Our own copy when others listen: reading the shared clone would leave them an unusable body.
            let source: Response | undefined = webClone;
            if (shared) {
              try {
                source = webClone.clone();
              } catch {
                source = undefined; // another listener already read it
              }
            }
            const err = (await source?.json().catch(() => undefined)) as { code?: unknown } | undefined;
            code = Number.isSafeInteger(err?.code) ? (err?.code as number) : undefined;
          }
          const timedOut = code === 10062 || (code === undefined && status === 404);
          opts.tracker.responded(id, {
            outcome: timedOut ? 'timeout' : 'error',
            ackMs,
            ...(code !== undefined ? { errorCode: code } : timedOut ? { errorCode: 10062 } : {}),
          });
        }
      }
    }

    // Free the tee'd copy of real clones so discord.js isn't holding every response twice, unless another listener
    // may still read it.
    if (webClone && !shared && !bodyHandled && !webClone.bodyUsed) await webClone.body?.cancel().catch(() => undefined);
  });

  const onRateLimited = opts.safe(
    'rateLimited',
    (info: {
      global: boolean;
      scope?: string;
      route: string;
      method: string;
      limit: number;
      retryAfter: number;
      sublimitTimeout?: number;
    }) => {
      // @discordjs/rest emits this only when it holds a request back, and always with `scope: 'user'`: a global wait
      // shows only in `global`. 429 responses are counted in the REST window instead.
      const scope = info.global ? 'global' : info.scope === 'shared' ? 'shared' : 'user';
      opts.enqueue(
        {
          id: uuidv7(),
          ts: Date.now(),
          type: 'rate_limit',
          scope,
          global: Boolean(info.global),
          route: normaliseRoute(info.route),
          method: String(info.method).toUpperCase().slice(0, 8),
          limit: clampedInt(info.limit, Number.MAX_SAFE_INTEGER) ?? 0,
          retryAfter: clamped(info.retryAfter, MAX_WAIT_MS) ?? 0,
          sublimitTimeout: clamped(info.sublimitTimeout, MAX_WAIT_MS) ?? 0,
        },
        2,
      );
    },
  );

  const onInvalid = opts.safe('invalidRequestWarning', (info: { count: number; remainingTime: number }) => {
    opts.enqueue(
      {
        id: uuidv7(),
        ts: Date.now(),
        type: 'invalid_request_warning',
        count: clampedInt(info.count, Number.MAX_SAFE_INTEGER) ?? 0,
        remainingTime: clamped(info.remainingTime, MAX_WAIT_MS) ?? 0,
      },
      2,
    );
  });

  rest.on(RESTEvents.Response, onResponse);
  rest.on(RESTEvents.RateLimited, onRateLimited);
  rest.on(RESTEvents.InvalidRequestWarning, onInvalid);

  // Time every HTTP call through the documented `makeRequest` option. The same `headers` object reaches the
  // `response` event, so it links timing to the bucketed route without reading any header.
  const restOptions = rest.options as { makeRequest: MakeRequest };
  const link = { next: restOptions.makeRequest };
  const wrapped: MakeRequest = async (url, init) => {
    const started = performance.now();
    try {
      return await link.next(url, init);
    } finally {
      try {
        const ref = init?.headers;
        if (ref && typeof ref === 'object') timings.set(ref, performance.now() - started);
      } catch (error) {
        opts.count('makeRequest', error);
      }
    }
  };
  nextRequest.set(wrapped, link);
  restOptions.makeRequest = wrapped;

  return {
    drain() {
      const total = invalid.count401 + invalid.count403 + invalid.count429 + invalid.shared429;
      if (rows.size === 0 && total === 0) {
        windowStart = Date.now();
        return undefined;
      }
      const now = Date.now();
      const event: RestWindowInput = {
        id: uuidv7(now),
        ts: now,
        type: 'rest_window',
        windowMs: Math.max(1, now - windowStart),
        rows: [...rows.values()],
        invalid,
      };
      rows = new Map();
      invalid = { count401: 0, count403: 0, count429: 0, shared429: 0 };
      windowStart = now;
      return event;
    },
    uninstall() {
      rest.off(RESTEvents.Response, onResponse);
      rest.off(RESTEvents.RateLimited, onRateLimited);
      rest.off(RESTEvents.InvalidRequestWarning, onInvalid);
      if (restOptions.makeRequest === wrapped) {
        restOptions.makeRequest = link.next;
        return;
      }
      // Another Shardlens wrapped ours: take ours out of the middle of the chain.
      for (let outer = nextRequest.get(restOptions.makeRequest); outer; outer = nextRequest.get(outer.next)) {
        if (outer.next === wrapped) {
          outer.next = link.next;
          return;
        }
      }
    },
  };
}
