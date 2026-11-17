import { createShardlensClient, type ShardlensClientOptions } from '../src/index.js';

export const URL_BASE = 'https://stats.example.com';
/** Shaped like the collector's keys, and made up. */
export const READ_KEY = `slk_read_${'r'.repeat(43)}`;
export const ACTIVITY_KEY = `slk_activity_${'a'.repeat(43)}`;
export const INGEST_KEY = `slk_ingest_${'i'.repeat(43)}`;

export const RANGE = { from: '2026-11-01T00:00:00.000Z', to: '2026-11-08T00:00:00.000Z' };

export interface Asked {
  method: string;
  url: URL;
  /** Path and query string. */
  path: string;
  headers: Headers;
  /** The parsed JSON body, if one was sent. */
  body: unknown;
  redirect: RequestRedirect | undefined;
  signal: AbortSignal | undefined;
}

/** A `fetch` that keeps what it was asked and answers with what `answer` returns. */
export function fakeCollector(answer: (asked: Asked) => Response | Promise<Response> = () => Response.json({})) {
  const asked: Asked[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const request: Asked = {
      method: init?.method ?? 'GET',
      url,
      path: url.pathname + url.search,
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      redirect: init?.redirect,
      signal: init?.signal ?? undefined,
    };
    asked.push(request);
    return answer(request);
  };
  return { asked, fetch: fetchImpl };
}

/** A client talking to a fake collector. */
export function clientFor(
  answer?: (asked: Asked) => Response | Promise<Response>,
  options: Partial<ShardlensClientOptions> = {},
) {
  const collector = fakeCollector(answer);
  const client = createShardlensClient({ url: URL_BASE, key: READ_KEY, fetch: collector.fetch, ...options });
  return { client, asked: collector.asked };
}

/** An answer that never comes: rejects when the request is aborted, or already was, as `fetch` does. */
export function never(asked: Asked): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = asked.signal;
    if (signal?.aborted) reject(signal.reason);
    else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

/** The error a promise rejects with. */
export async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}
