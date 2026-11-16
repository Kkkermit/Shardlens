import { describe, expect, it } from 'vitest';
import { type LiveUpdate, ShardlensClientError } from '../src/index.js';
import { serverSentEvents } from '../src/live.js';
import { type Asked, clientFor, never, READ_KEY, rejection } from './helpers.js';

const encoder = new TextEncoder();

/** A response body the test writes to, which notes whether its reader cancelled it. */
function sseBody() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const state = { cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return {
    stream,
    state,
    write: (text: string | Uint8Array) => controller.enqueue(typeof text === 'string' ? encoder.encode(text) : text),
    end: () => controller.close(),
    fail: (error: unknown) => controller.error(error),
    response: () => new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } }),
  };
}

function update(perMinute: number): LiveUpdate {
  return {
    ts: '2026-11-16T22:00:00.000Z',
    perMinute,
    errors15m: 0,
    perSecond: [],
    p95Ms5m: null,
    shards: [{ shard: 0, ping: 41, fresh: true }],
    activeShards: 1,
    staleShards: [],
    servers: 57,
  };
}

const tiles = (u: LiveUpdate) => `event: tiles\ndata: ${JSON.stringify(u)}\n\n`;

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of source) out.push(item);
  return out;
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

describe('serverSentEvents', () => {
  const events = async (chunks: (string | Uint8Array)[]) => {
    const body = sseBody();
    for (const chunk of chunks) body.write(chunk);
    body.end();
    return collect(serverSentEvents(body.stream.getReader()));
  };

  it('reads events and their data', async () => {
    expect(await events(['event: tiles\ndata: {"a":1}\n\n', 'data: plain\n\n'])).toEqual([
      { event: 'tiles', data: '{"a":1}' },
      { event: 'message', data: 'plain' },
    ]);
  });

  it('puts events back together that arrive split across chunks, at any byte', async () => {
    const text = 'event: tiles\ndata: {"name":"Café ☕ 🎲"}\n\nevent: tiles\ndata: {"n":2}\n\n';
    const bytes = encoder.encode(text);
    const expected = [
      { event: 'tiles', data: '{"name":"Café ☕ 🎲"}' },
      { event: 'tiles', data: '{"n":2}' },
    ];
    for (let size = 1; size <= bytes.length; size++) {
      const chunks: Uint8Array[] = [];
      for (let at = 0; at < bytes.length; at += size) chunks.push(bytes.slice(at, at + size));
      expect(await events(chunks), `chunks of ${size}`).toEqual(expected);
    }
  });

  it('ignores comments, heartbeats, retry hints and fields it does not know', async () => {
    const stream = ': connected\n\nretry: 5000\n\n: ping\nid: 7\nevent: tiles\n: ping\ndata: {"n":1}\n\n:\n\n';
    expect(await events([stream])).toEqual([{ event: 'tiles', data: '{"n":1}' }]);
  });

  it('takes CRLF and CR line endings, also when a chunk ends between the CR and the LF', async () => {
    const expected = [
      { event: 'tiles', data: '1' },
      { event: 'tiles', data: '2' },
    ];
    expect(await events(['event: tiles\r\ndata: 1\r\n\r\nevent: tiles\r\ndata: 2\r\n\r\n'])).toEqual(expected);
    expect(await events(['event: tiles\r', '\ndata: 1\r', '\n\r', '\nevent: tiles\r\ndata: 2\r\n\r', '\n'])).toEqual(
      expected,
    );
    expect(await events(['event: tiles\rdata: 1\r\revent: tiles\rdata: 2\r\r', ': end\n'])).toEqual(expected);
  });

  it('joins several data lines, and strips one leading space only', async () => {
    expect(await events(['data: one\ndata:two\ndata:  three\n\n'])).toEqual([
      { event: 'message', data: 'one\ntwo\n three' },
    ]);
  });

  it('drops an event the stream ended in the middle of', async () => {
    expect(await events([tiles(update(1)), 'event: tiles\ndata: {"perMin'])).toHaveLength(1);
  });
});

describe('live', () => {
  it('opens /v1/live with the key and yields each update', async () => {
    const body = sseBody();
    const { client, asked } = clientFor(() => body.response());
    body.write(`retry: 5000\n\n${tiles(update(1))}`);
    body.write(tiles(update(2)));
    body.end();
    expect(await collect(client.live())).toEqual([update(1), update(2)]);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ method: 'GET', path: '/v1/live', body: undefined });
    expect(asked[0]?.headers.get('authorization')).toBe(`Bearer ${READ_KEY}`);
    expect(asked[0]?.headers.get('accept')).toBe('text/event-stream');
  });

  it('connects when iteration starts, not when live() is called', async () => {
    const { client, asked } = clientFor(() => sseBody().response());
    const stream = client.live();
    await tick();
    expect(asked).toHaveLength(0);
    void stream[Symbol.asyncIterator]().next();
    await tick();
    expect(asked).toHaveLength(1);
  });

  it('skips the seconds the collector had no numbers for, and frames it cannot read', async () => {
    const body = sseBody();
    const { client } = clientFor(() => body.response());
    body.write(tiles(update(1)));
    body.write('event: error\ndata: {}\n\n');
    body.write('event: tiles\ndata: {not json\n\n');
    body.write(': heartbeat\n\n');
    body.write(tiles(update(2)));
    body.end();
    expect((await collect(client.live())).map((u) => u.perMinute)).toEqual([1, 2]);
  });

  it('yields an update that arrives in pieces once it is whole', async () => {
    const body = sseBody();
    const { client } = clientFor(() => body.response());
    const iterator = client.live()[Symbol.asyncIterator]();
    const frame = tiles(update(7));
    const first = iterator.next();
    body.write(frame.slice(0, 20));
    await tick();
    body.write(frame.slice(20, -1));
    await tick();
    body.write(frame.slice(-1));
    expect(await first).toEqual({ done: false, value: update(7) });
    body.end();
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
  });

  it('ends when the signal aborts, and closes the connection', async () => {
    const body = sseBody();
    const { client, asked } = clientFor(() => body.response());
    const controller = new AbortController();
    const seen: number[] = [];
    const done = (async () => {
      for await (const u of client.live({ signal: controller.signal })) seen.push(u.perMinute);
    })();
    body.write(tiles(update(1)));
    await tick();
    expect(seen).toEqual([1]);
    controller.abort();
    await expect(done).resolves.toBeUndefined();
    expect(body.state.cancelled).toBe(true);
    expect(asked[0]?.signal?.aborted).toBe(true);
  });

  it('ends without an error when a fetch ties the stream to the signal and fails it', async () => {
    const body = sseBody();
    const { client } = clientFor((asked) => {
      asked.signal?.addEventListener('abort', () => body.fail(asked.signal?.reason));
      return body.response();
    });
    const controller = new AbortController();
    const done = collect(client.live({ signal: controller.signal }));
    body.write(tiles(update(1)));
    await tick();
    controller.abort();
    await expect(done).resolves.toEqual([update(1)]);
  });

  it('asks nothing when the signal is already aborted, and ends when it aborts while connecting', async () => {
    const { client, asked } = clientFor(never);
    expect(await collect(client.live({ signal: AbortSignal.abort() }))).toEqual([]);
    expect(asked).toHaveLength(0);

    const controller = new AbortController();
    const done = collect(client.live({ signal: controller.signal }));
    await tick();
    expect(asked).toHaveLength(1);
    controller.abort();
    await expect(done).resolves.toEqual([]);
  });

  it('closes the connection when the consumer leaves the loop early', async () => {
    const body = sseBody();
    const { client, asked } = clientFor(() => body.response());
    body.write(tiles(update(1)));
    body.write(tiles(update(2)));
    for await (const u of client.live()) {
      expect(u.perMinute).toBe(1);
      break;
    }
    expect(body.state.cancelled).toBe(true);
    expect(asked[0]?.signal?.aborted).toBe(true);
  });

  it('closes the connection when the consumer’s loop throws', async () => {
    const body = sseBody();
    const { client } = clientFor(() => body.response());
    body.write(tiles(update(1)));
    const failing = (async () => {
      for await (const _ of client.live()) throw new Error('render failed');
    })();
    await expect(failing).rejects.toThrow('render failed');
    expect(body.state.cancelled).toBe(true);
  });

  it('keeps an open stream past the time limit, which covers connecting only', async () => {
    const body = sseBody();
    const { client, asked } = clientFor(() => body.response(), { timeoutMs: 20 });
    const iterator = client.live()[Symbol.asyncIterator]();
    const first = iterator.next();
    await tick(60);
    expect(asked[0]?.signal?.aborted).toBe(false);
    body.write(tiles(update(3)));
    expect(await first).toEqual({ done: false, value: update(3) });
    await iterator.return?.();
    expect(body.state.cancelled).toBe(true);
  });

  it('times out when the collector does not answer the connection', async () => {
    const { client } = clientFor(never, { timeoutMs: 20 });
    const error = await rejection(collect(client.live()));
    expect(error).toBeInstanceOf(ShardlensClientError);
    expect(error).toMatchObject({ status: 0, code: 'timeout' });
  });

  it('throws the collector’s refusal, with how long to wait when it is busy', async () => {
    const busy = (_: Asked) => Response.json({ error: 'busy' }, { status: 503, headers: { 'retry-after': '10' } });
    const error = await rejection(collect(clientFor(busy).client.live()));
    expect(error).toBeInstanceOf(ShardlensClientError);
    expect(error).toMatchObject({ status: 503, code: 'busy', retryAfterSeconds: 10 });

    const refused = () => Response.json({ error: 'unauthorized' }, { status: 401 });
    expect(await rejection(collect(clientFor(refused).client.live()))).toMatchObject({
      status: 401,
      code: 'unauthorized',
    });
  });

  it('reports a stream that breaks off as a network failure, after the updates it got', async () => {
    const body = sseBody();
    const { client } = clientFor(() => body.response());
    const cause = new TypeError('terminated');
    const seen: number[] = [];
    const reading = (async () => {
      for await (const u of client.live()) seen.push(u.perMinute);
    })();
    body.write(tiles(update(1)));
    await tick();
    body.fail(cause);
    const error = (await rejection(reading)) as ShardlensClientError;
    expect(seen).toEqual([1]);
    expect(error).toBeInstanceOf(ShardlensClientError);
    expect(error).toMatchObject({ status: 0, code: 'network' });
    expect(error.cause).toBe(cause);
    expect(error.message).not.toContain(READ_KEY);
  });
});
