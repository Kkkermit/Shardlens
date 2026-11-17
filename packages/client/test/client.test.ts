import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  type CommandsResult,
  createShardlensClient,
  type EventPropKeys,
  type EventPropsResult,
  type EventPropValues,
  lastDays,
  type OverviewResult,
  type QuerySpec,
  type SeriesResult,
  ShardlensClientError,
} from '../src/index.js';
import {
  ACTIVITY_KEY,
  clientFor,
  fakeCollector,
  INGEST_KEY,
  never,
  RANGE,
  READ_KEY,
  rejection,
  URL_BASE,
} from './helpers.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('options', () => {
  const create = (options: Record<string, unknown>) =>
    createShardlensClient({ url: URL_BASE, key: READ_KEY, ...options } as never);
  const refusal = (options: Record<string, unknown>) => {
    try {
      create(options);
    } catch (error) {
      return error as ShardlensClientError;
    }
    throw new Error('expected the options to be refused');
  };

  it('takes HTTPS anywhere, and HTTP only to this machine, as the SDK does', () => {
    for (const url of [
      'https://stats.example.com',
      'https://stats.example.com/',
      'http://localhost:8080',
      'http://127.0.0.1:8080',
      'http://[::1]:8080',
    ]) {
      expect(() => create({ url }), url).not.toThrow();
    }
    for (const url of [
      'http://stats.example.com',
      'http://localhost.example.com',
      'ftp://stats.example.com',
      'stats.example.com',
      '',
      undefined,
    ]) {
      const error = refusal({ url });
      expect(error, String(url)).toBeInstanceOf(ShardlensClientError);
      expect(error).toMatchObject({ status: 0, code: 'invalid_options' });
      expect(error.message).toBe('url must be https:// (or http://localhost)');
    }
  });

  it('refuses a URL that carries a user name or password, without repeating it', () => {
    const error = refusal({ url: 'https://admin:hunter2@stats.example.com' });
    expect(error.message).toBe('url must not contain a user name or password');
    expect(error.message).not.toContain('hunter2');
  });

  it('takes a read key or an activity key', () => {
    expect(() => create({ key: READ_KEY })).not.toThrow();
    expect(() => create({ key: ACTIVITY_KEY })).not.toThrow();
  });

  it('says an ingest key can only send events', () => {
    const error = refusal({ key: INGEST_KEY });
    expect(error).toMatchObject({ status: 0, code: 'invalid_options' });
    expect(error.message).toContain('ingest key, which can only send events');
    expect(error.message).toContain('slk_read_…');
    expect(error.message).toContain('slk_activity_…');
  });

  it('refuses anything else that is not a read or activity key', () => {
    for (const key of [
      '',
      undefined,
      'hunter2',
      'slk_read_short',
      `${READ_KEY}\n`,
      ` ${READ_KEY}`,
      `"${READ_KEY}"`,
      `slk_write_${'w'.repeat(43)}`,
    ]) {
      expect(refusal({ key }), String(key)).toMatchObject({ status: 0, code: 'invalid_options' });
    }
  });

  it('never repeats the key, even when it was put where the URL goes', () => {
    const refused = [
      refusal({ key: INGEST_KEY }),
      refusal({ key: `${READ_KEY}x` }),
      refusal({ url: READ_KEY }),
      refusal({ url: `https://${READ_KEY}@stats.example.com` }),
      refusal({ url: `http://stats.example.com/?key=${READ_KEY}` }),
    ];
    for (const error of refused) {
      expect(`${error.message}\n${error.stack}`).not.toContain(READ_KEY);
      expect(`${error.message}\n${error.stack}`).not.toContain(INGEST_KEY);
    }
  });

  it('asks the collector nothing until a method is called', () => {
    const { asked } = clientFor();
    expect(asked).toHaveLength(0);
  });

  it('uses the global fetch unless given one, looked up at call time', async () => {
    const client = createShardlensClient({ url: URL_BASE, key: READ_KEY });
    const collector = fakeCollector(() => Response.json({ servers: 3 }));
    vi.stubGlobal('fetch', collector.fetch);
    await expect(client.overview()).resolves.toEqual({ servers: 3 });
    expect(collector.asked).toHaveLength(1);
  });

  it('falls back to 10 seconds for a time limit that is not a positive number', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    try {
      for (const timeoutMs of [Number.NaN, 0, -5, undefined]) {
        await clientFor(undefined, { timeoutMs }).client.overview();
        expect(timeout).toHaveBeenLastCalledWith(10_000);
      }
      await clientFor(undefined, { timeoutMs: 2_500 }).client.overview();
      expect(timeout).toHaveBeenLastCalledWith(2_500);
    } finally {
      timeout.mockRestore();
    }
  });
});

describe('queries', () => {
  it('posts the spec to /v1/query with the key as a bearer token', async () => {
    const answer = { periodStart: '2026-11-01', rows: [] };
    const { client, asked } = clientFor(() => Response.json(answer));
    await expect(client.commands({ range: RANGE })).resolves.toEqual(answer);
    expect(asked).toHaveLength(1);
    const [request] = asked;
    expect(request?.method).toBe('POST');
    expect(request?.url.href).toBe('https://stats.example.com/v1/query');
    expect(request?.headers.get('authorization')).toBe(`Bearer ${READ_KEY}`);
    expect(request?.headers.get('content-type')).toBe('application/json');
    expect(request?.body).toEqual({ kind: 'commands', range: RANGE });
    expect(request?.signal).toBeInstanceOf(AbortSignal);
  });

  it('asks the collector at its root, whatever path the URL came with', async () => {
    const { client, asked } = clientFor(undefined, { url: 'http://localhost:8080/dashboard/' });
    await client.overview();
    expect(asked[0]?.url.href).toBe('http://localhost:8080/v1/query');
  });

  it('builds the spec of the methods that take more than a spec', async () => {
    const { client, asked } = clientFor();
    await client.overview();
    await client.command('ticket', { range: RANGE });
    await client.server('112233445566778899');
    await client.servers();
    await client.servers({ status: 'all', sort: 'runs', limit: 10 });
    expect(asked.map((a) => a.body)).toEqual([
      { kind: 'overview' },
      { kind: 'command', name: 'ticket', range: RANGE },
      { kind: 'server', guild: '112233445566778899' },
      { kind: 'servers' },
      { kind: 'servers', status: 'all', sort: 'runs', limit: 10 },
    ]);
  });

  it('sends filters and options as given', async () => {
    const { client, asked } = clientFor();
    const filters = [
      { field: 'guild', value: '112233445566778899' },
      { field: 'outcome', op: 'in', value: ['error', 'timeout'] },
    ] as const;
    await client.top({ metric: 'interactions', groupBy: 'command', range: RANGE, filters, limit: 10 });
    await client.series({
      metric: 'custom',
      name: 'ticket_opened',
      interval: 'day',
      range: RANGE,
      timezone: 'Europe/London',
    });
    expect(asked.map((a) => a.body)).toEqual([
      { kind: 'top', metric: 'interactions', groupBy: 'command', range: RANGE, filters, limit: 10 },
      {
        kind: 'series',
        metric: 'custom',
        name: 'ticket_opened',
        interval: 'day',
        range: RANGE,
        timezone: 'Europe/London',
      },
    ]);
  });

  it('has one method for every kind of query, each asking for its own kind', async () => {
    const { client, asked } = clientFor();
    const step = { type: 'event', name: 'ticket_opened' } as const;
    const calls: Record<QuerySpec['kind'], () => Promise<unknown>> = {
      series: () => client.series({ metric: 'interactions', interval: 'day', range: RANGE }),
      top: () => client.top({ metric: 'interactions', groupBy: 'command', range: RANGE }),
      heatmap: () => client.heatmap({ range: RANGE }),
      commands: () => client.commands({ range: RANGE }),
      command: () => client.command('ticket', { range: RANGE }),
      servers: () => client.servers(),
      server: () => client.server('112233445566778899'),
      growth: () => client.growth({ range: RANGE }),
      audience: () => client.audience({ range: RANGE }),
      overview: () => client.overview(),
      gauge: () => client.gauge({ name: 'shard.ping_ms', interval: 'hour', range: RANGE }),
      bursts: () => client.bursts({ range: RANGE }),
      reliability: () => client.reliability({ range: RANGE }),
      premium: () => client.premium({ range: RANGE }),
      installs: () => client.installs({ range: RANGE }),
      events: () => client.events({ range: RANGE }),
      eventProps: () => client.eventProps({ name: 'ticket_opened', range: RANGE }),
      funnel: () => client.funnel({ steps: [step, { type: 'command', name: 'ticket' }], range: RANGE }),
      retention: () => client.retention({ start: step, range: RANGE }),
    };
    for (const [kind, call] of Object.entries(calls)) {
      await call();
      expect(asked.at(-1)?.path, kind).toBe('/v1/query');
      expect(asked.at(-1)?.body, kind).toMatchObject({ kind });
    }
    expect(asked).toHaveLength(19);
  });

  it('does not let a spec change which kind a method asks for', async () => {
    const { client, asked } = clientFor();
    await client.commands({ range: RANGE, kind: 'overview' } as never);
    await client.command('ticket', { range: RANGE, name: 'help' } as never);
    expect(asked.map((a) => a.body)).toEqual([
      { kind: 'commands', range: RANGE },
      { kind: 'command', name: 'ticket', range: RANGE },
    ]);
  });

  it('runs any spec through query(), typed by its kind', async () => {
    const answer = { timezone: 'UTC', points: [{ t: '2026-11-01T00:00:00', key: null, value: 4 }] };
    const { client, asked } = clientFor(() => Response.json(answer));
    const spec = { kind: 'series', metric: 'interactions', interval: 'day', range: RANGE } as const;
    const series = await client.query(spec);
    expect(series).toEqual(answer);
    expect(asked[0]?.body).toEqual(spec);

    expectTypeOf(series).toEqualTypeOf<SeriesResult>();
    expectTypeOf(client.query({ kind: 'overview' })).resolves.toEqualTypeOf<OverviewResult>();
    expectTypeOf(client.query({ kind: 'commands', range: RANGE })).resolves.toEqualTypeOf<CommandsResult>();
  });

  it('types an eventProps answer by whether the query names a property', async () => {
    const { client, asked } = clientFor();
    const spec = { name: 'ticket_opened', range: RANGE };
    const keys = client.eventProps(spec);
    const values = client.eventProps({ ...spec, prop: 'category' });
    const either = client.eventProps({ ...spec, prop: asked.length > 0 ? 'category' : undefined });
    expectTypeOf(keys).resolves.toEqualTypeOf<EventPropKeys>();
    expectTypeOf(values).resolves.toEqualTypeOf<EventPropValues>();
    expectTypeOf(either).resolves.toEqualTypeOf<EventPropsResult>();
    await Promise.all([keys, values, either]);
    expect(asked.map((a) => a.body)).toEqual([
      { kind: 'eventProps', ...spec },
      { kind: 'eventProps', ...spec, prop: 'category' },
      { kind: 'eventProps', ...spec, prop: 'category' },
    ]);
  });

  it('reads /v1/meta with a GET', async () => {
    const meta = { appId: '1234567890123456789', name: 'Demo bot', mode: 'privacy' };
    const { client, asked } = clientFor(() => Response.json(meta));
    await expect(client.meta()).resolves.toEqual(meta);
    expect(asked[0]).toMatchObject({ method: 'GET', path: '/v1/meta', body: undefined });
    expect(asked[0]?.headers.get('authorization')).toBe(`Bearer ${READ_KEY}`);
    expect(asked[0]?.headers.has('content-type')).toBe(false);
  });

  it("rejects with the caller's own reason when the caller aborts", async () => {
    const { client } = clientFor(never);
    const controller = new AbortController();
    const pending = client.overview({ signal: controller.signal });
    const reason = new Error('the visitor left the page');
    controller.abort(reason);
    expect(await rejection(pending)).toBe(reason);

    const aborted = AbortSignal.abort();
    const error = await rejection(clientFor(never).client.commands({ range: RANGE }, { signal: aborted }));
    expect(error).not.toBeInstanceOf(ShardlensClientError);
    expect(error).toBe(aborted.reason);
  });
});

describe('failures', () => {
  const failing = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    clientFor(() => Response.json(body, { status, headers }));

  it('maps the collector’s error answers to status and code', async () => {
    const cases = [
      { status: 401, body: { error: 'unauthorized' }, text: 'refused the key' },
      { status: 403, body: { error: 'activity_key_required' }, text: 'activity key (slk_activity_…)' },
      { status: 404, body: { error: 'audit_mode_off' }, text: 'not in audit mode' },
      { status: 404, body: { error: 'not_found' }, text: 'The collector answered 404 (not_found).' },
    ];
    for (const c of cases) {
      const error = await rejection(failing(c.status, c.body).client.overview());
      expect(error, c.body.error).toBeInstanceOf(ShardlensClientError);
      expect(error).toMatchObject({
        name: 'ShardlensClientError',
        status: c.status,
        code: c.body.error,
        retryAfterSeconds: undefined,
        requestId: undefined,
      });
      expect((error as Error).message).toContain(c.text);
    }
  });

  it('passes on the collector’s own message when it gives one', async () => {
    const body = { error: 'invalid_query', message: 'minute series are limited to 2 days' };
    const error = await rejection(failing(400, body).client.overview());
    expect(error).toMatchObject({ status: 400, code: 'invalid_query', message: 'minute series are limited to 2 days' });
  });

  it('names the fields an invalid request got wrong', async () => {
    const body = {
      error: 'invalid_request',
      issues: [
        { path: ['range', 'from'], message: 'Invalid ISO datetime' },
        { path: ['limit'], message: 'Too big: expected number to be <=500' },
      ],
    };
    const error = await rejection(failing(400, body).client.overview());
    expect(error).toMatchObject({ status: 400, code: 'invalid_request' });
    expect((error as Error).message).toBe(
      'The collector refused the request (invalid_request): range.from: Invalid ISO datetime; limit: Too big: expected number to be <=500',
    );
  });

  it('reads Retry-After on a 429, as seconds or as a date', async () => {
    const seconds = await rejection(failing(429, { error: 'rate_limited' }, { 'retry-after': '30' }).client.overview());
    expect(seconds).toMatchObject({ status: 429, code: 'rate_limited', retryAfterSeconds: 30 });

    const at = new Date(Date.now() + 90_000).toUTCString();
    const dated = (await rejection(
      failing(429, { error: 'rate_limited' }, { 'retry-after': at }).client.overview(),
    )) as ShardlensClientError;
    expect(dated.retryAfterSeconds).toBeGreaterThan(85);
    expect(dated.retryAfterSeconds).toBeLessThanOrEqual(90);

    const bare = await rejection(failing(429, { error: 'rate_limited' }).client.overview());
    expect(bare).toMatchObject({ status: 429, retryAfterSeconds: undefined });
    const odd = await rejection(failing(429, { error: 'rate_limited' }, { 'retry-after': 'soon' }).client.overview());
    expect(odd).toMatchObject({ status: 429, retryAfterSeconds: undefined });
  });

  it('keeps the request ID of a 500, to find it in the collector’s log', async () => {
    const error = await rejection(failing(500, { error: 'internal', requestId: 'req-1f' }).client.overview());
    expect(error).toMatchObject({ status: 500, code: 'internal', requestId: 'req-1f' });
    expect((error as Error).message).toBe('The collector ran into an error. Request ID: req-1f');
  });

  it('gives an answer without a code one from its status', async () => {
    const page = () =>
      new Response('<html>Bad gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } });
    const error = await rejection(clientFor(page).client.overview());
    expect(error).toMatchObject({ status: 502, code: 'http_502', message: 'The collector answered 502 (http_502).' });
    const empty = await rejection(clientFor(() => new Response(null, { status: 404 })).client.meta());
    expect(empty).toMatchObject({ status: 404, code: 'http_404' });
  });

  it('follows no redirect, and says the address redirects', async () => {
    const moved = () =>
      new Response(null, { status: 301, headers: { location: 'https://www.stats.example.com/v1/query' } });
    const { client, asked } = clientFor(moved);
    const error = await rejection(client.commands({ range: RANGE }));
    expect(asked[0]?.redirect).toBe('manual');
    expect(error).toBeInstanceOf(ShardlensClientError);
    expect(error).toMatchObject({ status: 301, code: 'http_301' });
    expect((error as Error).message).toContain("a redirect, which the client doesn't follow");
    await client.meta().catch(() => undefined);
    expect(asked[1]?.redirect).toBe('manual');
  });

  it('refuses a 2xx answer that is not JSON', async () => {
    const page = () => new Response('<html>Sign in</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    const error = await rejection(clientFor(page).client.overview());
    expect(error).toBeInstanceOf(ShardlensClientError);
    expect(error).toMatchObject({ status: 200, code: 'invalid_response' });
  });

  it('times out after timeoutMs, with the abort as the cause', async () => {
    const { client, asked } = clientFor(never, { timeoutMs: 20 });
    const error = (await rejection(client.overview())) as ShardlensClientError;
    expect(error).toBeInstanceOf(ShardlensClientError);
    expect(error).toMatchObject({ status: 0, code: 'timeout' });
    expect(error.message).toBe('The collector at https://stats.example.com did not answer within 20 ms.');
    expect(error.cause).toMatchObject({ name: 'TimeoutError' });
    expect(asked[0]?.signal?.aborted).toBe(true);
  });

  it('reports a network failure with its cause', async () => {
    const cause = new TypeError('fetch failed');
    const { client } = clientFor(() => Promise.reject(cause));
    const error = (await rejection(client.commands({ range: RANGE }))) as ShardlensClientError;
    expect(error).toBeInstanceOf(ShardlensClientError);
    expect(error).toMatchObject({ status: 0, code: 'network' });
    expect(error.message).toBe('Could not reach the collector at https://stats.example.com.');
    expect(error.cause).toBe(cause);
  });

  it('reports an answer that breaks off while it is read as a network failure', async () => {
    const broken = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"rows":['));
            controller.error(new TypeError('terminated'));
          },
        }),
      );
    const error = await rejection(clientFor(broken).client.overview());
    expect(error).toMatchObject({ status: 0, code: 'network' });
  });

  it('never puts the key in an error message', async () => {
    const answers: (() => Response | Promise<Response>)[] = [
      () => Response.json({ error: 'unauthorized' }, { status: 401 }),
      () => Response.json({ error: 'activity_key_required' }, { status: 403 }),
      () => Response.json({ error: 'rate_limited' }, { status: 429, headers: { 'retry-after': '5' } }),
      () => Response.json({ error: 'internal', requestId: 'req-2' }, { status: 500 }),
      () => new Response('nope', { status: 503 }),
      () => new Response('not json'),
      () => Promise.reject(new TypeError('fetch failed')),
    ];
    for (const answer of answers) {
      const error = (await rejection(clientFor(answer).client.overview())) as ShardlensClientError;
      expect(error).toBeInstanceOf(ShardlensClientError);
      expect(`${error.message}\n${error.stack}\n${JSON.stringify(error)}`).not.toContain(READ_KEY);
    }
    const timedOut = (await rejection(clientFor(never, { timeoutMs: 10 }).client.overview())) as ShardlensClientError;
    expect(`${timedOut.message}\n${timedOut.stack}`).not.toContain(READ_KEY);
  });
});

describe('lastDays', () => {
  it('ends now and starts that many days earlier', () => {
    const before = Date.now();
    const range = lastDays(7);
    const after = Date.now();
    const to = Date.parse(range.to);
    expect(to).toBeGreaterThanOrEqual(before);
    expect(to).toBeLessThanOrEqual(after);
    expect(to - Date.parse(range.from)).toBe(7 * 86_400_000);
    expect(range.from).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(range.to).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  });

  it('takes part of a day', () => {
    const range = lastDays(0.5);
    expect(Date.parse(range.to) - Date.parse(range.from)).toBe(43_200_000);
  });

  it('refuses a number of days it cannot make a range from', () => {
    for (const days of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, undefined as unknown as number]) {
      expect(() => lastDays(days), String(days)).toThrow(ShardlensClientError);
    }
  });
});
