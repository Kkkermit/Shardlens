import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

export class ApiError extends Error {
  readonly status: number;
  /** The collector's error code (`invalid_request`, `not_found`), or `http_<status>` when the answer had none. */
  readonly code: string;
  /** The collector's own explanation, when it gave one (a webhook that Discord refused, a missing audit key). */
  readonly detail: string | undefined;
  /** The collector's ID for a request it failed on, to quote when reporting the problem. */
  readonly requestId: string | undefined;
  /** The fields an `invalid_request` answer names. */
  readonly fields: string[];
  constructor(status: number, code: string, details: { detail?: string; requestId?: string; fields?: string[] } = {}) {
    super(details.detail ?? code);
    this.status = status;
    this.code = code;
    this.detail = details.detail;
    this.requestId = details.requestId;
    this.fields = details.fields ?? [];
  }
}

const FIELD_NAMES: Record<string, string> = {
  name: 'the name',
  label: 'the label',
  threshold: 'the threshold',
  windowS: 'the time window',
  webhookUrl: 'the webhook URL',
  timezone: 'the time zone',
  rawRetentionDays: 'the raw event retention',
  auditRetentionDays: 'the audit retention',
  requiredPermissions: 'the permission bits',
  skuPrices: 'the SKU prices',
  userId: 'the user ID',
  hour: 'the hour',
  weekday: 'the weekday',
  guild: 'the server ID',
  user: 'the user ID',
  command: 'the command',
};

/** Codes the collector answers with no explanation of its own, in words. */
const CODES: Record<string, string> = {
  internal: 'The collector ran into an error.',
  busy: 'The collector is busy. Try again in a few seconds.',
  not_found: 'It no longer exists. Reload the page to see what is there now.',
  unauthorized: 'Your session has ended. Sign in again.',
  discord_login_required: 'This needs a Discord sign-in.',
  not_a_team_member: 'Only the app owner and its team members can do this.',
  csrf: 'The request was refused. Reload the page and try again.',
  audit_mode_off: 'Audit mode is off.',
};

/** A message for a failed request that is safe to show as text. */
export function errorText(error: unknown): string {
  // fetch rejects with a TypeError when there is no answer at all (offline, collector down, connection reset).
  if (error instanceof TypeError) return "Couldn't reach the collector. Check your connection and try again.";
  if (!(error instanceof ApiError)) return 'Something went wrong.';
  if (error.status === 429) return 'Too many attempts. Wait a minute and try again.';
  if (error.code === 'invalid_request') {
    const names = [...new Set(error.fields.map((f) => (Object.hasOwn(FIELD_NAMES, f) ? FIELD_NAMES[f] : f)))];
    return names.length > 0
      ? `Please check ${names.join(', ')} and try again.`
      : 'Please check the values and try again.';
  }
  if (error.detail) return error.detail;
  if (Object.hasOwn(CODES, error.code)) return CODES[error.code] as string;
  // A proxy in front of the collector answers with a page, not a code.
  if (error.status >= 500) return CODES.internal as string;
  return `The request failed (${error.code}).`;
}

let unauthorized: (() => void) | undefined;

/** Called when a request is refused for want of a session (it expired, or another tab signed out). */
export function onUnauthorized(handler: () => void): void {
  unauthorized = handler;
}

/**
 * Same-origin request. State-changing requests carry the CSRF header the collector requires. An answer other than 2xx
 * is thrown as an {@link ApiError}.
 */
export async function request(
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal; headers?: Record<string, string> } = {},
): Promise<Response> {
  const method = init.method ?? (init.body === undefined ? 'GET' : 'POST');
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: {
      accept: 'application/json',
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'x-shardlens-csrf': '1' } : {}),
      ...init.headers,
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    ...(init.signal ? { signal: init.signal } : {}),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: unknown;
      message?: unknown;
      requestId?: unknown;
      issues?: { path?: unknown[] }[];
    };
    // A sign-in attempt answers 401 for a wrong key; anywhere else it means the session is gone.
    if (res.status === 401 && !path.startsWith('/auth/')) unauthorized?.();
    const fields = (Array.isArray(body.issues) ? body.issues : [])
      .map((issue) => issue.path?.[0])
      .filter((f): f is string => typeof f === 'string');
    throw new ApiError(res.status, typeof body.error === 'string' ? body.error : `http_${res.status}`, {
      ...(typeof body.message === 'string' ? { detail: body.message } : {}),
      ...(typeof body.requestId === 'string' ? { requestId: body.requestId } : {}),
      fields,
    });
  }
  return res;
}

/** A same-origin JSON request (see {@link request}). */
export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  return (await (await request(path, init)).json()) as T;
}

export interface Me {
  authenticated: boolean;
  method: 'discord' | 'read_key' | 'demo' | null;
  userId: string | null;
  discordLogin: boolean;
  /** A public demo collector: visitors read without signing in. */
  demo?: boolean;
}

export interface Meta {
  appId: string;
  name: string;
  mode: 'privacy' | 'audit';
  saltPeriod: 'day' | 'week' | 'month';
  timezone: string;
  rawRetentionDays: number;
  auditKeyConfigured: boolean;
  discordLogin: boolean;
  webhookEventsConfigured: boolean;
}

export const useMe = () => useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/auth/me'), staleTime: 60_000 });
export const useMeta = () => useQuery({ queryKey: ['meta'], queryFn: () => api<Meta>('/v1/meta'), staleTime: 300_000 });

/** True while any of these shows the previous answer because a new one (another range, page or filter) is loading. */
export const updating = (...queries: { isPlaceholderData: boolean }[]) => queries.some((q) => q.isPlaceholderData);

/**
 * Runs a typed query spec. Queries are cancelled when the component unmounts or the spec changes. `refreshMs` asks
 * again that often while the page is open and visible, for a page people leave open (the Overview).
 */
export function useSpec<T>(
  spec: Record<string, unknown> | null,
  options: { refreshMs?: (data: T | undefined) => number } = {},
) {
  return useQuery<T>({
    queryKey: ['query', spec],
    queryFn: ({ signal }) => api<T>('/v1/query', { body: spec, signal }),
    enabled: spec !== null,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    refetchInterval: (query) => options.refreshMs?.(query.state.data) ?? false,
  });
}

export interface LiveTiles {
  ts: string;
  perMinute: number;
  errors15m: number;
  perSecond: number[];
  p95Ms5m?: number | null;
  activeShards?: number;
  staleShards?: number[];
  servers?: number;
  shards?: { shard: number; ping: number; fresh: boolean }[];
}

/** Live tiles over Server-Sent Events, reconnecting with backoff. `stale` is true while disconnected. */
export function useLive(): { tiles: LiveTiles | undefined; stale: boolean } {
  const client = useQueryClient();
  const [tiles, setTiles] = useState<LiveTiles>();
  const [stale, setStale] = useState(true);
  const attempt = useRef(0);
  useEffect(() => {
    let source: EventSource | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const connect = () => {
      source = new EventSource('/v1/live');
      source.addEventListener('tiles', (e) => {
        attempt.current = 0;
        setStale(false);
        try {
          setTiles(JSON.parse((e as MessageEvent<string>).data) as LiveTiles);
        } catch {
          // ignore malformed frames
        }
      });
      source.onerror = () => {
        setStale(true);
        source?.close();
        if (closed) return;
        // An EventSource can't tell why it failed: ask whether the session is still there, so an expired one goes
        // back to the sign-in page (which closes this stream) instead of reconnecting forever.
        void client.invalidateQueries({ queryKey: ['me'] });
        const delay = Math.min(30_000, 1_000 * 2 ** attempt.current++);
        timer = setTimeout(connect, delay);
      };
    };
    connect();
    return () => {
      closed = true;
      source?.close();
      if (timer) clearTimeout(timer);
    };
  }, [client]);
  return { tiles, stale };
}
