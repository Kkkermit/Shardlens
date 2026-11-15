import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

export class ApiError extends Error {
  readonly status: number;
  /** The collector's ID for a request it failed on, to quote when reporting the problem. */
  readonly requestId: string | undefined;
  /** The fields an `invalid_request` answer names. */
  readonly fields: string[];
  constructor(status: number, message: string, details: { requestId?: string; fields?: string[] } = {}) {
    super(message);
    this.status = status;
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
};

/** A message for a failed request that is safe to show as text. */
export function errorText(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Something went wrong.';
  if (error.status === 429) return 'Too many attempts. Wait a minute and try again.';
  if (error.message === 'invalid_request') {
    const names = [...new Set(error.fields.map((f) => (Object.hasOwn(FIELD_NAMES, f) ? FIELD_NAMES[f] : f)))];
    return names.length > 0
      ? `Please check ${names.join(', ')} and try again.`
      : 'Please check the values and try again.';
  }
  return error.message;
}

let unauthorized: (() => void) | undefined;

/** Called when a request is refused for want of a session (it expired, or another tab signed out). */
export function onUnauthorized(handler: () => void): void {
  unauthorized = handler;
}

/** Same-origin JSON request. State-changing requests carry the CSRF header the collector requires. */
export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const method = init.method ?? (init.body === undefined ? 'GET' : 'POST');
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: {
      accept: 'application/json',
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'x-shardlens-csrf': '1' } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    ...(init.signal ? { signal: init.signal } : {}),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
      requestId?: unknown;
      issues?: { path?: unknown[] }[];
    };
    // A sign-in attempt answers 401 for a wrong key; anywhere else it means the session is gone.
    if (res.status === 401 && !path.startsWith('/auth/')) unauthorized?.();
    const fields = (Array.isArray(body.issues) ? body.issues : [])
      .map((issue) => issue.path?.[0])
      .filter((f): f is string => typeof f === 'string');
    throw new ApiError(res.status, body.message ?? body.error ?? res.statusText, {
      ...(typeof body.requestId === 'string' ? { requestId: body.requestId } : {}),
      fields,
    });
  }
  return (await res.json()) as T;
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

/** Runs a typed query spec. Queries are cancelled when the component unmounts or the spec changes. */
export function useSpec<T>(spec: Record<string, unknown> | null) {
  return useQuery({
    queryKey: ['query', spec],
    queryFn: ({ signal }) => api<T>('/v1/query', { body: spec, signal }),
    enabled: spec !== null,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
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
