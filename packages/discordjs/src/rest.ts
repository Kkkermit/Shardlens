import { newHistogram, observe, uuidv7 } from '@shardlens/core';
import type { EventInput } from '@shardlens/schema';
import { type Client, RESTEvents } from 'discord.js';
import type { InteractionTracker } from './interactions.js';
import { normaliseRoute } from './util.js';

type RestWindowInput = Extract<EventInput, { type: 'rest_window' }>;
type RestRow = RestWindowInput['rows'][number];

/** Bucketed route @discordjs/rest uses for every initial interaction response. */
const CALLBACK_ROUTE = '/interactions/:id/:token/callback';
/** Interaction callback type for "open a modal". */
const MODAL = 9;
const MAX_ROWS = 2_000;
const OVERFLOW_ROUTE = '(other)';

type Rest = Client['rest'];
type MakeRequest = Rest['options']['makeRequest'];
type ResponseListener = (...args: Parameters<Parameters<Rest['on']>[1]>) => void;

/** A real WHATWG `Response`. Only these are true clones that are safe to read or cancel. */
function isWebResponse(value: unknown): value is Response {
  return typeof Response !== 'undefined' && value instanceof Response;
}

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
    let key = `${method} ${route} ${status}`;
    if (!rows.has(key) && rows.size >= MAX_ROWS) key = `${method} ${OVERFLOW_ROUTE} ${status}`;
    let row = rows.get(key);
    if (!row) {
      row = {
        method,
        route: rows.size >= MAX_ROWS ? OVERFLOW_ROUTE : route,
        status,
        count: 0,
        retries: 0,
        latency: newHistogram(),
      };
      rows.set(key, row);
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
            const err = (await webClone.json().catch(() => undefined)) as { code?: unknown } | undefined;
            code = typeof err?.code === 'number' ? err.code : undefined;
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

    // Free the tee'd copy of real clones so discord.js isn't holding every response twice.
    if (webClone && !bodyHandled && !webClone.bodyUsed) await webClone.body?.cancel().catch(() => undefined);
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
      const scope = info.scope === 'global' || info.scope === 'shared' ? info.scope : 'user';
      opts.enqueue(
        {
          id: uuidv7(),
          ts: Date.now(),
          type: 'rate_limit',
          scope,
          global: Boolean(info.global),
          route: normaliseRoute(info.route),
          method: String(info.method).toUpperCase().slice(0, 8),
          limit: Number.isFinite(info.limit) ? Math.trunc(info.limit) : 0,
          retryAfter: Math.max(0, info.retryAfter ?? 0),
          sublimitTimeout: Math.max(0, info.sublimitTimeout ?? 0),
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
        count: Math.trunc(info.count),
        remainingTime: info.remainingTime,
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
  const original = restOptions.makeRequest;
  const wrapped: MakeRequest = async (url, init) => {
    const started = performance.now();
    try {
      return await original(url, init);
    } finally {
      try {
        const ref = init?.headers;
        if (ref && typeof ref === 'object') timings.set(ref, performance.now() - started);
      } catch (error) {
        opts.count('makeRequest', error);
      }
    }
  };
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
      if (restOptions.makeRequest === wrapped) restOptions.makeRequest = original;
    },
  };
}
