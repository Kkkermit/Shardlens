import type { FastifyInstance, InjectOptions } from 'fastify';

/** Statuses whose response has no body: `Response` refuses one. */
const NO_BODY = new Set([204, 205, 304]);

/**
 * A `fetch` answered by `app.inject`, signed in with `apiKey` whatever the request carries: no socket, no port. As
 * `fetch` does, it rejects with the signal's reason once the request's signal aborts, even while the answer is still
 * being worked out.
 */
export function inProcessFetch(app: FastifyInstance, apiKey: string): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    request.signal.throwIfAborted();
    const url = new URL(request.url);
    const headers = Object.fromEntries(request.headers);
    headers.authorization = `Bearer ${apiKey}`;
    // Answers come back as they are: nothing here would decompress one.
    delete headers['accept-encoding'];
    const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer();
    const answer = app.inject({
      method: request.method as NonNullable<InjectOptions['method']>,
      url: `${url.pathname}${url.search}`,
      headers,
      ...(body ? { payload: Buffer.from(body) } : {}),
    });
    const res = await untilAborted(answer, request.signal);
    const out = new Headers();
    for (const [name, value] of Object.entries(res.headers)) {
      if (value === undefined) continue;
      for (const one of Array.isArray(value) ? value : [value]) out.append(name, String(one));
    }
    const empty = NO_BODY.has(res.statusCode) || request.method === 'HEAD';
    return new Response(empty ? null : res.rawPayload, { status: res.statusCode, headers: out });
  };
}

/** `promise`, or a rejection with the signal's reason as soon as it aborts. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
