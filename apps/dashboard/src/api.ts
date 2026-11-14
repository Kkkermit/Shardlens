import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** A message for a failed request that is safe to show as text. */
export function errorText(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Something went wrong.';
  return error.message === 'invalid_request' ? 'Please check the values and try again.' : error.message;
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
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new ApiError(res.status, body.message ?? body.error ?? res.statusText);
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
  }, []);
  return { tiles, stale };
}
