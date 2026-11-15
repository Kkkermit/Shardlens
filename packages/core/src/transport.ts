/** Uses the Web-standard `CompressionStream`, so it works in Node, Bun, Deno and Workers. */
export async function gzipJson(value: unknown): Promise<Uint8Array> {
  return gzip(new TextEncoder().encode(JSON.stringify(value)));
}

export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export const BACKOFF_MIN_MS = 1_000;
export const BACKOFF_MAX_MS = 60_000;

/** Exponential backoff with equal jitter (half fixed, half random), capped at 60 seconds. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.max(0, attempt));
  return Math.round(base / 2 + random() * (base / 2));
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Whether the SDK may send to this collector URL: HTTPS only, except plain HTTP to a loopback host for local
 * development. URLs with credentials are refused so keys never travel in the URL.
 */
export function isAllowedEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
}
