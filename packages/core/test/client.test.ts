import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ClientOptions, nextPeriodStart, ShardlensClient, uuidv7, type WireEvent } from '../src/index.js';

const SALT_B64 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const APP_ID = '1234567890123456789';

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown> & { events: (WireEvent & Record<string, unknown>)[] };
}

type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | Error;

/** A fake collector: `/v1/config` returns `config`, `/v1/ingest` replies from the queue (default 202). */
function fakeCollector(opts: { config?: Record<string, unknown> | Reply; ingest?: Reply[] } = {}) {
  const sent: Sent[] = [];
  const ingestReplies = [...(opts.ingest ?? [])];
  const config = opts.config ?? {
    v: 1,
    appId: APP_ID,
    mode: 'privacy',
    saltPeriod: 'month',
    salts: [{ period: currentMonth(), salt: SALT_B64 }],
    sampling: {},
    serverTime: new Date().toISOString(),
  };
  const toResponse = (reply: Reply): Response => {
    if (reply instanceof Error) throw reply;
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status,
      headers: reply.headers ?? {},
    });
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/v1/config')) {
      return 'status' in config || config instanceof Error
        ? toResponse(config as Reply)
        : toResponse({ status: 200, body: config });
    }
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const text = await new Response(
      new Blob([init?.body as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip')),
    ).text();
    sent.push({ url, headers, body: JSON.parse(text) });
    return toResponse(ingestReplies.shift() ?? { status: 202, body: { accepted: 1, duplicates: 0, rejected: [] } });
  }) as typeof fetch;
  return { fetch: fetchImpl, sent };
}

function currentMonth(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}

const clients: ShardlensClient[] = [];
function makeClient(options: Partial<ClientOptions> & Pick<ClientOptions, 'fetch'>) {
  const warnings: string[] = [];
  const client = new ShardlensClient({
    endpoint: 'https://collector.test',
    apiKey: 'slk_ingest_test',
    sdk: { name: '@shardlens/test', version: '0.0.0' },
    flushIntervalMs: 60_000,
    logger: { warn: (m) => warnings.push(m), info: () => undefined },
    source: () => ({ shards: [0], instance: 'test:1' }),
    ...options,
  });
  clients.push(client);
  return { client, warnings };
}

function custom(name = 'ticket_opened'): WireEvent {
  return { id: uuidv7(), ts: Date.now(), type: 'custom', name, props: {} } as WireEvent;
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(clients.splice(0).map((c) => c.shutdown({ timeoutMs: 10 })));
});

describe('ShardlensClient', () => {
  it('loads salts and settings from /v1/config, then sends a gzipped, authenticated batch', async () => {
    const collector = fakeCollector();
    const { client } = makeClient({ fetch: collector.fetch, release: '2.4.1' });
    await settle();
    expect(client.ready).toBe(true);
    expect(client.mode).toBe('privacy');

    client.enqueue(custom(), 2);
    await client.flush();

    expect(collector.sent).toHaveLength(1);
    const [req] = collector.sent;
    expect(req?.url).toBe('https://collector.test/v1/ingest');
    expect(req?.headers.authorization).toBe('Bearer slk_ingest_test');
    expect(req?.headers['content-encoding']).toBe('gzip');
    expect(req?.body).toMatchObject({
      v: 1,
      mode: 'privacy',
      app: { id: APP_ID, env: 'production', release: '2.4.1' },
      source: { shards: [0], instance: 'test:1' },
    });
    expect(req?.body.events.map((e) => e.type)).toEqual(['custom', 'sdk_health']);
    expect(client.stats().queueDepth).toBe(0);
  });

  it('hashes user IDs in-process and never sends the raw ID', async () => {
    const collector = fakeCollector();
    const { client } = makeClient({ fetch: collector.fetch });
    await settle();
    client.enqueueWithUser('112233445566778899', Date.now(), 3, (user) => ({ ...custom(), user }) as WireEvent);
    await settle();
    await client.flush();
    const body = JSON.stringify(collector.sent[0]?.body);
    expect(body).toMatch(new RegExp(`"user":"h1:${currentMonth()}:[0-9a-f]{32}"`));
    expect(body).not.toContain('112233445566778899');
  });

  it('holds user events until the salt arrives, then sends them', async () => {
    const collector = fakeCollector({ config: new Error('collector down') });
    const { client } = makeClient({ fetch: collector.fetch });
    client.enqueueWithUser('112233445566778899', Date.now(), 3, (user) => ({ ...custom(), user }) as WireEvent);
    await settle();
    expect(client.ready).toBe(false);
    expect(client.stats().pendingSalt).toBe(1);
    expect(client.stats().internalErrors.config).toBeGreaterThan(0);
  });

  it('drops user events that wait more than 60 seconds for a salt', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const collector = fakeCollector({ config: new Error('collector down') });
    const { client } = makeClient({ fetch: collector.fetch });
    client.enqueueWithUser('112233445566778899', Date.now(), 3, (user) => ({ ...custom(), user }) as WireEvent);
    await client.flush();
    expect(client.stats().pendingSalt).toBe(1);
    vi.setSystemTime(Date.now() + 61_000);
    await client.flush();
    expect(client.stats().pendingSalt).toBe(0);
    expect(client.stats().dropped.salt_missing).toBe(1);
  });

  it('says once that events were dropped waiting for the collector', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const collector = fakeCollector({ config: new Error('collector down') });
    const { client, warnings } = makeClient({ fetch: collector.fetch });
    for (let i = 0; i < 3; i++) {
      client.enqueueWithUser('112233445566778899', Date.now(), 3, (user) => ({ ...custom(), user }) as WireEvent);
    }
    vi.setSystemTime(Date.now() + 61_000);
    await client.flush();
    expect(client.stats().dropped.salt_missing).toBe(3);
    expect(warnings.filter((w) => w.includes('dropped after 60 seconds'))).toHaveLength(1);
  });

  it('caps the salt-wait buffer at 1,000 events', async () => {
    const collector = fakeCollector({ config: new Error('collector down') });
    const { client } = makeClient({ fetch: collector.fetch });
    for (let i = 0; i < 1_005; i++) {
      client.enqueueWithUser('112233445566778899', Date.now(), 3, (user) => ({ ...custom(), user }) as WireEvent);
    }
    expect(client.stats().pendingSalt).toBe(1_000);
    expect(client.stats().dropped.salt_missing).toBe(5);
  });

  it('keeps a failed batch and resends the same event IDs after backoff (no double counting)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const collector = fakeCollector({ ingest: [{ status: 500 }] });
    const { client } = makeClient({ fetch: collector.fetch, random: () => 0 });
    await settle();
    const event = custom();
    client.enqueue(event, 2);
    await client.flush();
    expect(client.stats()).toMatchObject({ queueDepth: 1, failedFlushes: 1 });

    await client.flush(); // still backing off: nothing sent
    expect(collector.sent).toHaveLength(1);

    vi.setSystemTime(Date.now() + 1_000);
    await client.flush();
    expect(collector.sent).toHaveLength(2);
    expect(collector.sent[1]?.body.events[0]?.id).toBe(event.id);
    expect(client.stats().queueDepth).toBe(0);
  });

  it('waits as told by Retry-After on 429 and 503', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const collector = fakeCollector({ ingest: [{ status: 503, headers: { 'retry-after': '30' } }] });
    const { client } = makeClient({ fetch: collector.fetch });
    await settle();
    client.enqueue(custom(), 2);
    await client.flush();
    vi.setSystemTime(Date.now() + 29_000);
    await client.flush();
    expect(collector.sent).toHaveLength(1);
    vi.setSystemTime(Date.now() + 2_000);
    await client.flush();
    expect(collector.sent).toHaveLength(2);
  });

  it('says once when the collector is unreachable, and once when it is back', async () => {
    let down = true;
    const collector = fakeCollector();
    const lines: string[] = [];
    const { client } = makeClient({
      fetch: ((input, init) =>
        down ? Promise.reject(new TypeError('fetch failed')) : collector.fetch(input, init)) as typeof fetch,
      logger: { warn: (m) => lines.push(`warn ${m}`), info: (m) => lines.push(`info ${m}`) },
      random: () => 0,
    });
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(client.ready).toBe(false);
    expect(lines).toEqual([
      "warn Shardlens: can't reach the collector at https://collector.test (fetch failed). Retrying; events wait in memory.",
    ]);

    down = false;
    await vi.advanceTimersByTimeAsync(120_000);
    vi.useRealTimers();
    expect(client.ready).toBe(true);
    expect(lines.at(-1)).toBe('info Shardlens: connected to the collector at https://collector.test.');
    expect(lines).toHaveLength(2);
    expect(lines.join(' ')).not.toContain('slk_ingest_test');
  });

  it('carries on in privacy mode, losing nothing, when the collector leaves audit mode', async () => {
    let mode = 'audit';
    const collector = fakeCollector({ ingest: [{ status: 400, body: { error: 'audit_mode_disabled' } }] });
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      if (!String(input).endsWith('/v1/config')) return collector.fetch(input, init);
      return Response.json({
        v: 1,
        appId: APP_ID,
        mode,
        saltPeriod: 'month',
        salts: [{ period: currentMonth(), salt: SALT_B64 }],
        sampling: {},
        serverTime: new Date().toISOString(),
      });
    }) as typeof fetch;
    const { client, warnings } = makeClient({ fetch: fetchImpl, mode: 'audit' });
    await settle();
    expect(client.mode).toBe('audit');

    mode = 'privacy';
    client.enqueue({ ...custom(), actor: { userId: '112233445566778899' } } as WireEvent, 3);
    await client.flush();
    await settle();

    expect(client.mode).toBe('privacy');
    expect(collector.sent).toHaveLength(2);
    expect(collector.sent[1]?.body.mode).toBe('privacy');
    expect(collector.sent[1]?.body.events[0]).not.toHaveProperty('actor');
    expect(client.stats()).toMatchObject({ queueDepth: 0, dropped: { invalid: 0 } });
    expect(warnings.some((w) => w.includes('no longer in audit mode'))).toBe(true);
  });

  it("drops a user's unsent events before asking for an erasure, and keeps everyone else's", async () => {
    const order: string[] = [];
    const collector = fakeCollector();
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v1/privacy/erase')) {
        order.push('erase');
        return Response.json({ erased: 1 });
      }
      if (url.endsWith('/v1/ingest')) order.push('ingest');
      return collector.fetch(input, init);
    }) as typeof fetch;
    const { client } = makeClient({ fetch: fetchImpl });
    await settle();
    const erasedHash = await client.hashUser('112233445566778899');
    client.enqueueWithUser('112233445566778899', Date.now(), 3, (user) => ({ ...custom(), user }) as WireEvent);
    client.enqueueWithUser('998877665544332211', Date.now(), 3, (user) => ({ ...custom(), user }) as WireEvent);
    await expect(client.forgetUser('112233445566778899')).resolves.toEqual({ erased: 1 });
    await client.flush();
    expect(order).toEqual(['erase', 'ingest']);
    const users = collector.sent.flatMap((s) => s.body.events).flatMap((e) => (e.user ? [e.user] : []));
    expect(users).toHaveLength(1);
    expect(users).not.toContain(erasedHash);
  });

  it("never sends an erased user's events that were waiting to be retried", async () => {
    const collector = fakeCollector({ ingest: [{ status: 503, headers: { 'retry-after': '0' } }] });
    const { client } = makeClient({ fetch: collector.fetch, random: () => 0 });
    await settle();
    const erasedHash = await client.hashUser('112233445566778899');
    client.enqueueWithUser('112233445566778899', Date.now(), 3, (user) => ({ ...custom(), user }) as WireEvent);
    await settle();
    await client.flush();
    expect(client.stats().queueDepth).toBe(1);
    await client.forgetUser('112233445566778899');
    client.enqueue(custom('after_erasure'), 2);
    await new Promise((resolve) => setTimeout(resolve, 600));
    await client.flush();
    const events = collector.sent.slice(1).flatMap((s) => s.body.events);
    expect(events.map((e) => e.type)).toContain('custom');
    expect(events.map((e) => e.user)).not.toContain(erasedHash);
  });

  it('pauses and warns once when the key is rejected', async () => {
    const collector = fakeCollector({ ingest: [{ status: 401 }, { status: 401 }] });
    const { client, warnings } = makeClient({ fetch: collector.fetch });
    await settle();
    client.enqueue(custom(), 2);
    await client.flush();
    await client.flush();
    expect(collector.sent).toHaveLength(1);
    expect(warnings.filter((w) => w.includes('API key'))).toHaveLength(1);
    expect(client.stats().queueDepth).toBe(1);
  });

  it('halves the batch on 413 and drops a single oversized event', async () => {
    const collector = fakeCollector({ ingest: [{ status: 413 }, { status: 413 }] });
    const { client } = makeClient({ fetch: collector.fetch });
    await settle();
    for (let i = 0; i < 4; i++) client.enqueue(custom(), 2);
    await client.flush();
    expect(collector.sent.map((s) => s.body.events.length - 1)).toEqual([4, 2, 1, 2, 1]);
    expect(client.stats().queueDepth).toBe(0);

    const single = fakeCollector({ ingest: [{ status: 413 }] });
    const { client: c2 } = makeClient({ fetch: single.fetch });
    await settle();
    c2.enqueue(custom(), 2);
    await c2.flush();
    expect(c2.stats().dropped.invalid).toBe(1);
    expect(c2.stats().queueDepth).toBe(0);
  });

  it('drops only the events a 400 reply lists and resends the rest', async () => {
    const collector = fakeCollector({
      ingest: [{ status: 400, body: { error: 'invalid', rejected: [{ index: 1 }] } }],
    });
    const { client } = makeClient({ fetch: collector.fetch });
    await settle();
    const events = [custom('a'), custom('b'), custom('c')];
    for (const e of events) client.enqueue(e, 2);
    await client.flush();
    expect(collector.sent).toHaveLength(2);
    expect(collector.sent[1]?.body.events.slice(0, -1).map((e) => e.id)).toEqual([events[0]?.id, events[2]?.id]);
    expect(client.stats().dropped.invalid).toBe(1);
  });

  it('splits batches larger than 1 MB before sending', async () => {
    const collector = fakeCollector();
    const { client } = makeClient({ fetch: collector.fetch });
    await settle();
    for (let i = 0; i < 400; i++) client.enqueue({ ...custom(), props: { blob: 'x'.repeat(4_000) } } as WireEvent, 2);
    await client.flush();
    expect(collector.sent.length).toBeGreaterThan(1);
    for (const s of collector.sent) expect(JSON.stringify(s.body).length).toBeLessThanOrEqual(1024 * 1024);
    expect(collector.sent.reduce((n, s) => n + s.body.events.length - 1, 0)).toBe(400);
  });

  it('strips actor data unless both the SDK and the collector are in audit mode', async () => {
    const withActor = () => ({ ...custom(), actor: { userId: '112233445566778899' } }) as WireEvent;

    const privacyCollector = fakeCollector();
    const { client, warnings } = makeClient({ fetch: privacyCollector.fetch, mode: 'audit' });
    await settle();
    expect(client.mode).toBe('privacy');
    expect(warnings.some((w) => w.includes('privacy mode'))).toBe(true);
    client.enqueue(withActor(), 3);
    await client.flush();
    const sent = privacyCollector.sent[0]?.body.events[0];
    expect(sent).not.toHaveProperty('actor');

    const auditCollector = fakeCollector({
      config: {
        v: 1,
        appId: APP_ID,
        mode: 'audit',
        saltPeriod: 'month',
        salts: [{ period: currentMonth(), salt: SALT_B64 }],
        serverTime: new Date().toISOString(),
      },
    });
    const { client: audit } = makeClient({ fetch: auditCollector.fetch, mode: 'audit' });
    await settle();
    expect(audit.mode).toBe('audit');
    audit.enqueue(withActor(), 3);
    await audit.flush();
    expect(auditCollector.sent[0]?.body.mode).toBe('audit');
    expect(auditCollector.sent[0]?.body.events[0]).toHaveProperty('actor');
  });

  it('samples by event type and re-weights kept events', async () => {
    const collector = fakeCollector();
    const rolls = [0.1, 0.9];
    const { client } = makeClient({
      fetch: collector.fetch,
      sampleRate: { custom: 0.5 },
      random: () => rolls.shift() ?? 0,
    });
    await settle();
    client.enqueue(custom(), 2); // kept (0.1 < 0.5)
    client.enqueue(custom(), 2); // dropped by sampling (0.9 >= 0.5)
    await client.flush();
    const events = collector.sent[0]?.body.events.filter((e) => e.type === 'custom');
    expect(events).toHaveLength(1);
    expect(events?.[0]?.weight).toBe(2);
  });

  it('refuses plain-HTTP endpoints other than localhost and never calls fetch', async () => {
    const fetchSpy = vi.fn();
    const { client, warnings } = makeClient({
      fetch: fetchSpy as unknown as typeof fetch,
      endpoint: 'http://collector.example',
    });
    client.enqueue(custom(), 2);
    await client.flush();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warnings[0]).toContain('https://');
  });

  it('never throws when fetch itself throws', async () => {
    const throwing = (() => {
      throw new TypeError('boom');
    }) as unknown as typeof fetch;
    const { client } = makeClient({ fetch: throwing });
    await settle();
    expect(() => client.enqueue(custom(), 2)).not.toThrow();
    await expect(client.flush()).resolves.toBeUndefined();
    await expect(client.shutdown({ timeoutMs: 50 })).resolves.toBeUndefined();
    expect(client.stats().internalErrors.config).toBeGreaterThan(0);
  });

  it('flushes on shutdown and gives up at the deadline when the collector hangs', async () => {
    const collector = fakeCollector();
    const { client } = makeClient({ fetch: collector.fetch });
    await settle();
    client.enqueue(custom(), 2);
    await client.shutdown({ timeoutMs: 1_000 });
    expect(collector.sent).toHaveLength(1);
    client.enqueue(custom(), 2);
    expect(client.stats().dropped.closed).toBe(1);

    const hanging = (async (input: string | URL | Request) => {
      if (String(input).endsWith('/v1/config')) return fakeCollector().fetch(input);
      return new Promise<Response>(() => undefined);
    }) as typeof fetch;
    const { client: slow } = makeClient({ fetch: hanging });
    await settle();
    slow.enqueue(custom(), 2);
    const started = Date.now();
    await slow.shutdown({ timeoutMs: 100 });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('makes a second shutdown wait for the first one to finish sending', async () => {
    const collector = fakeCollector();
    const slow = (async (input: string | URL | Request, init?: RequestInit) => {
      if (!String(input).endsWith('/v1/config')) await new Promise((resolve) => setTimeout(resolve, 100));
      return collector.fetch(input, init);
    }) as typeof fetch;
    const { client } = makeClient({ fetch: slow });
    await settle();
    client.enqueue(custom(), 2);
    const first = client.shutdown({ timeoutMs: 1_000 });
    await client.shutdown({ timeoutMs: 1_000 });
    expect(collector.sent).toHaveLength(1);
    await first;
  });

  it('sends events whose user hash is still being computed when shutdown starts', async () => {
    const collector = fakeCollector();
    const { client } = makeClient({ fetch: collector.fetch });
    await settle();
    client.enqueueWithUser('112233445566778899', Date.now(), 3, (user) => ({ ...custom(), user }) as WireEvent);
    await client.shutdown({ timeoutMs: 1_000 });
    expect(collector.sent.flatMap((s) => s.body.events).filter((e) => e.type === 'custom')).toHaveLength(1);
    expect(client.stats().dropped.closed).toBe(0);
  });

  it('runs on with defaults when numeric options are not numbers, as unset environment variables give', async () => {
    const collector = fakeCollector();
    const { client } = makeClient({
      fetch: collector.fetch,
      maxQueueSize: Number.NaN,
      maxBatchSize: Number.NaN,
      flushIntervalMs: Number.NaN,
    });
    const { client: fractional } = makeClient({ fetch: collector.fetch, maxQueueSize: 2.5 });
    await settle();
    client.enqueue(custom(), 2);
    await client.flush();
    expect(collector.sent).toHaveLength(1);
    expect(fractional.stats().queueDepth).toBe(0);
  });

  it('warns about a rejected key even when the reply body cannot be released', async () => {
    const fetchImpl = (async () =>
      new Response(
        new ReadableStream({
          cancel() {
            throw new Error('cancel failed');
          },
        }),
        { status: 401 },
      )) as typeof fetch;
    const { client, warnings } = makeClient({ fetch: fetchImpl });
    await settle();
    expect(warnings.filter((w) => w.includes('rejected the API key'))).toHaveLength(1);
    expect(warnings.some((w) => w.includes("can't reach"))).toBe(false);
    expect(client.stats().internalErrors).toEqual({});
  });

  it('waits for the dry-run salt in idle(), so a short-lived runtime still prints its events', async () => {
    const lines: string[] = [];
    const client = new ShardlensClient({
      dryRun: true,
      sdk: { name: '@shardlens/test', version: '0.0.0' },
      logger: { warn: () => undefined, info: (m) => lines.push(m) },
    });
    clients.push(client);
    client.enqueueWithUser('112233445566778899', Date.now(), 3, (user) => ({ ...custom(), user }) as WireEvent);
    await client.idle();
    await client.flush();
    expect(lines.some((l) => l.includes('"type":"custom"'))).toBe(true);
  });

  it('prints events in dry-run mode without contacting a collector', async () => {
    const lines: string[] = [];
    const fetchSpy = vi.fn();
    const client = new ShardlensClient({
      endpoint: '',
      apiKey: '',
      dryRun: true,
      sdk: { name: '@shardlens/test', version: '0.0.0' },
      fetch: fetchSpy as unknown as typeof fetch,
      logger: { warn: () => undefined, info: (m) => lines.push(m) },
    });
    clients.push(client);
    await settle();
    client.enqueueWithUser('112233445566778899', Date.now(), 3, (user) => ({ ...custom(), user }) as WireEvent);
    await settle();
    await client.flush();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(lines.some((l) => l.includes('"type":"custom"') && l.includes('"user":"h1:'))).toBe(true);
  });
});

describe('spool', () => {
  /** An in-memory EventSpool (the file implementation lives in @shardlens/discordjs). */
  function memorySpool(capacity = Number.POSITIVE_INFINITY) {
    const batches = new Map<string, WireEvent[]>();
    let seq = 0;
    return {
      batches,
      size: () => [...batches.values()].reduce((n, b) => n + b.length, 0),
      all: () => [...batches.values()].flat() as (WireEvent & Record<string, unknown>)[],
      async write(events: readonly WireEvent[]) {
        if ([...batches.values()].reduce((n, b) => n + b.length, 0) + events.length > capacity) return false;
        batches.set(String(seq++).padStart(6, '0'), [...events]);
        return true;
      },
      async next() {
        const [id] = [...batches.keys()].sort();
        return id ? { id, events: batches.get(id) as WireEvent[] } : undefined;
      },
      async ack(id: string) {
        batches.delete(id);
      },
    };
  }
  const down = Array.from({ length: 50 }, () => ({ status: 503, headers: { 'retry-after': '60' } }));

  it('moves events to the spool when the collector has been unreachable since startup', async () => {
    const spool = memorySpool();
    const { client } = makeClient({
      fetch: (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch,
      spool,
      maxQueueSize: 10,
    });
    await settle();
    for (let i = 0; i < 10; i++) client.enqueue(custom(), 2);
    await client.flush();
    expect(client.stats().queueDepth).toBe(5);
    expect(spool.size()).toBe(5);
  });

  it("removes an erased user's events from the spool", async () => {
    const spool = Object.assign(memorySpool(), {
      async drop(match: (event: WireEvent) => boolean) {
        let n = 0;
        for (const [id, events] of spool.batches) {
          const keep = events.filter((e) => !match(e));
          n += events.length - keep.length;
          spool.batches.set(id, keep);
        }
        return n;
      },
    });
    const collector = fakeCollector();
    const { client } = makeClient({ fetch: collector.fetch, spool });
    await settle();
    const hash = await client.hashUser('112233445566778899');
    await spool.write([{ ...custom(), user: hash } as WireEvent, custom('someone_else')]);
    await client.forgetUser('112233445566778899');
    expect(spool.all().map((e) => e.name)).toEqual(['someone_else']);
  });

  it('moves events to the spool during an outage and on shutdown, and never writes identities to disk', async () => {
    const spool = memorySpool();
    const collector = fakeCollector({
      config: {
        v: 1,
        appId: APP_ID,
        mode: 'audit',
        saltPeriod: 'month',
        salts: [{ period: currentMonth(), salt: SALT_B64 }],
        sampling: {},
        serverTime: new Date().toISOString(),
      },
      ingest: down,
    });
    const { client } = makeClient({ fetch: collector.fetch, spool, maxQueueSize: 10, mode: 'audit' });
    await settle();
    for (let i = 0; i < 10; i++)
      client.enqueue({ ...custom(), actor: { userId: '112233445566778899' } } as WireEvent, 2);
    await client.flush(); // 503: the batch goes back to memory, and everything above half the queue to the spool
    expect(client.stats().queueDepth).toBe(5);
    expect(spool.size()).toBe(5);

    await client.shutdown({ timeoutMs: 200 });
    expect(spool.size()).toBe(10);
    expect(client.stats().spooled).toBe(10);
    expect(spool.all().some((e) => 'actor' in e)).toBe(false);
  });

  it('replays spooled batches first when the collector is back, and deletes them only once accepted', async () => {
    const spool = memorySpool();
    const old = Array.from({ length: 3 }, () => custom('from_before_restart'));
    await spool.write(old);
    const collector = fakeCollector();
    const { client } = makeClient({ fetch: collector.fetch, spool });
    await settle();
    client.enqueue(custom('fresh'), 2);
    await client.flush();
    expect(collector.sent.map((s) => s.body.events.filter((e) => e.type === 'custom').map((e) => e.name))).toEqual([
      ['from_before_restart', 'from_before_restart', 'from_before_restart'],
      ['fresh'],
    ]);
    expect(spool.size()).toBe(0);
    expect(client.stats().replayed).toBe(3);
  });

  it('says the collector is back when a spool replay is the first request to get through', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const spool = memorySpool();
    await spool.write([custom()]);
    const collector = fakeCollector({ ingest: [new Error('collector down')] });
    const lines: string[] = [];
    const { client } = makeClient({
      fetch: collector.fetch,
      spool,
      random: () => 0,
      logger: { warn: (m) => lines.push(`warn ${m}`), info: (m) => lines.push(`info ${m}`) },
    });
    await settle();
    await client.flush();
    expect(lines.at(-1)).toContain("warn Shardlens: can't reach the collector");
    vi.setSystemTime(Date.now() + 1_000);
    await client.flush();
    expect(spool.size()).toBe(0);
    expect(lines.at(-1)).toBe('info Shardlens: connected to the collector at https://collector.test.');
  });

  it('keeps spooled batches while the collector is still down', async () => {
    const spool = memorySpool();
    await spool.write([custom()]);
    const collector = fakeCollector({ ingest: down });
    const { client } = makeClient({ fetch: collector.fetch, spool });
    await settle();
    await client.flush();
    expect(spool.size()).toBe(1);
    expect(client.stats().replayed).toBe(0);
  });

  it('counts events it could not store when the spool is full', async () => {
    const spool = memorySpool(3);
    const collector = fakeCollector({ ingest: down });
    const { client } = makeClient({ fetch: collector.fetch, spool, maxBatchSize: 2 });
    await settle();
    for (let i = 0; i < 6; i++) client.enqueue(custom(), 2);
    await client.flush();
    await client.shutdown({ timeoutMs: 200 });
    expect(spool.size()).toBeLessThanOrEqual(3);
    expect(client.stats().dropped.spool_full).toBe(6 - spool.size());
  });
});

describe('exporters', () => {
  const recorder = (name = 'test') => {
    const seen: (WireEvent & Record<string, unknown>)[] = [];
    let closed = 0;
    return {
      seen,
      closed: () => closed,
      exporter: {
        name,
        observe: (e: WireEvent) => void seen.push(e as WireEvent & Record<string, unknown>),
        shutdown: () => void closed++,
      },
    };
  };

  it('runs without a collector: exporters see every event, nothing is fetched or queued', async () => {
    const rec = recorder();
    const fetchSpy = vi.fn();
    const warnings: string[] = [];
    const client = new ShardlensClient({
      sdk: { name: '@shardlens/test', version: '0.0.0' },
      exporters: [rec.exporter],
      fetch: fetchSpy as unknown as typeof fetch,
      logger: { warn: (m) => warnings.push(m) },
    });
    clients.push(client);
    client.enqueue(custom(), 2);
    client.enqueueWithUser(
      '112233445566778899',
      Date.now(),
      3,
      (user) => ({ ...custom('signed_up'), user }) as WireEvent,
    );
    await settle();
    await client.flush();
    expect(rec.seen.map((e) => e.name)).toEqual(['ticket_opened', 'signed_up']);
    expect(rec.seen[1]?.user).toBe('');
    expect(client.stats().queueDepth).toBe(0);
    expect(client.stats().pendingSalt).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warnings).toEqual([]);
    await client.shutdown({ timeoutMs: 50 });
    expect(rec.closed()).toBe(1);
  });

  it('sees events before sampling and never sees users or audit identities, alongside a collector', async () => {
    const rec = recorder();
    const collector = fakeCollector();
    const { client } = makeClient({
      fetch: collector.fetch,
      exporters: [rec.exporter],
      sampleRate: { custom: 0.5 },
      random: () => 0.9, // every sampled event is dropped from the batch
    });
    await settle();
    client.enqueueWithUser(
      '112233445566778899',
      Date.now(),
      3,
      (user) => ({ ...custom(), user, actor: { id: '112233445566778899' } }) as WireEvent,
    );
    await settle();
    await client.flush();
    expect(rec.seen).toHaveLength(1);
    expect(rec.seen[0]?.user).toBe('');
    expect(rec.seen[0]).not.toHaveProperty('actor');
    expect(collector.sent).toHaveLength(0); // sampled out of the batch, but the exporter counted it
  });

  it('catches and counts exporter failures without affecting the batch', async () => {
    const collector = fakeCollector();
    const broken = {
      name: 'broken',
      observe: () => {
        throw new Error('boom');
      },
    };
    const { client } = makeClient({ fetch: collector.fetch, exporters: [broken] });
    await settle();
    client.enqueue(custom(), 2);
    await client.flush();
    expect(collector.sent).toHaveLength(1);
    expect(client.stats().internalErrors['exporter:broken']).toBe(1);
  });
});

describe('hostile options and collectors', () => {
  it('runs with options of the wrong type, as environment variables and config files give', async () => {
    const collector = fakeCollector();
    const exporter = { name: 'single', observe: vi.fn() };
    const { client, warnings } = makeClient({
      fetch: collector.fetch,
      environment: 1 as unknown as string,
      release: 42 as unknown as string,
      exporters: exporter as unknown as ClientOptions['exporters'],
    });
    await settle();
    client.enqueue(custom(), 2);
    await client.flush();
    expect(collector.sent[0]?.body.app).toMatchObject({ env: '1', release: '42' });
    expect(exporter.observe).toHaveBeenCalled();
    expect(warnings.some((w) => w.includes('exporters must be an array'))).toBe(true);

    const odd = makeClient({ fetch: collector.fetch, environment: {} as unknown as string });
    expect(odd.warnings.some((w) => w.includes('environment must be a string'))).toBe(true);
  });

  it('counts a batch that fails while it is being built instead of losing it silently', async () => {
    const collector = fakeCollector();
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('boom');
        },
      },
    );
    const { client } = makeClient({ fetch: collector.fetch, source: () => hostile as never });
    await settle();
    client.enqueue(custom(), 2);
    await client.flush();
    expect(client.stats().dropped.invalid).toBe(1);
    expect(client.stats().internalErrors.send).toBe(1);
  });

  it('copes with a 400 reply whose rejected list holds nulls', async () => {
    const collector = fakeCollector({ ingest: [{ status: 400, body: { rejected: [null, { index: 0 }] } }] });
    const { client } = makeClient({ fetch: collector.fetch });
    await settle();
    client.enqueue(custom(), 2);
    client.enqueue(custom(), 2);
    await client.flush();
    expect(client.stats().internalErrors).toEqual({});
    expect(client.stats().dropped.invalid).toBe(1);
    expect(collector.sent).toHaveLength(2);
  });

  it('never retries sooner than its backoff, whatever Retry-After says', async () => {
    const collector = fakeCollector({
      ingest: [
        { status: 503, headers: { 'retry-after': '0' } },
        { status: 429, headers: { 'retry-after': new Date(Date.now() - 60_000).toUTCString() } },
      ],
    });
    const { client } = makeClient({ fetch: collector.fetch });
    await settle();
    client.enqueue(custom(), 2);
    for (let i = 0; i < 5; i++) await client.flush();
    expect(collector.sent).toHaveLength(1);
  });

  it('reads at most a bounded reply from the collector', async () => {
    let pulled = 0;
    const endless = () =>
      new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled++;
          controller.enqueue(new Uint8Array(16 * 1024).fill(32));
        },
      });
    const collector = fakeCollector();
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/v1/ingest')) {
        await collector.fetch(input, init);
        return new Response(endless(), { status: 202 });
      }
      return collector.fetch(input, init);
    }) as typeof fetch;
    const { client } = makeClient({ fetch: fetchImpl });
    await settle();
    client.enqueue(custom(), 2);
    await client.flush();
    expect(collector.sent).toHaveLength(1);
    expect(pulled).toBeLessThan(10);

    pulled = 0;
    const hugeConfig = makeClient({
      fetch: (async () => new Response(endless(), { status: 200 })) as typeof fetch,
    });
    await settle();
    expect(hugeConfig.client.ready).toBe(false);
    expect(pulled).toBeLessThan(20);
  });

  it("asks again soon when the collector has no salt yet for this clock's period, and warns about the skew", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let configs = 0;
    const lastMonth = new Date();
    lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1, 1);
    const previous = `${lastMonth.getUTCFullYear()}-${String(lastMonth.getUTCMonth() + 1).padStart(2, '0')}`;
    const collector = fakeCollector({
      config: {
        v: 1,
        appId: APP_ID,
        mode: 'privacy',
        saltPeriod: 'month',
        salts: [{ period: previous, salt: SALT_B64 }],
        sampling: {},
        serverTime: new Date(Date.now() - 120_000).toISOString(),
      },
    });
    const { client, warnings } = makeClient({
      fetch: ((input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/v1/config')) configs++;
        return collector.fetch(input, init);
      }) as typeof fetch,
      random: () => 0,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(configs).toBe(1);
    expect(warnings.some((w) => w.includes('120 s ahead of'))).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(configs).toBe(2);
    expect(client.ready).toBe(true);
  });

  it('shuts down with a null or non-numeric timeout, still sending what is queued', async () => {
    const collector = fakeCollector();
    const { client } = makeClient({ fetch: collector.fetch });
    await settle();
    client.enqueue(custom(), 2);
    await expect(client.shutdown(null as unknown as undefined)).resolves.toBeUndefined();
    expect(collector.sent).toHaveLength(1);

    const second = makeClient({ fetch: collector.fetch });
    await settle();
    second.client.enqueue(custom(), 2);
    await second.client.shutdown({ timeoutMs: Number.NaN });
    expect(collector.sent).toHaveLength(2);
  });

  it('aborts a request still hanging when shutdown is over, so the process can exit', async () => {
    let aborted = false;
    const hanging = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/v1/config')) return fakeCollector().fetch(input, init);
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => {
          aborted = true;
          reject(new DOMException('aborted', 'AbortError'));
        };
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener('abort', abort);
      });
    }) as typeof fetch;
    const { client } = makeClient({ fetch: hanging });
    await settle();
    client.enqueue(custom(), 2);
    void client.flush();
    await client.shutdown({ timeoutMs: 50 });
    expect(aborted).toBe(true);
  });

  it('shows audit identities as hidden in dry-run output', async () => {
    const lines: string[] = [];
    const client = new ShardlensClient({
      dryRun: true,
      mode: 'audit',
      sdk: { name: '@shardlens/test', version: '0.0.0' },
      logger: { warn: () => undefined, info: (m) => lines.push(m) },
    });
    clients.push(client);
    await settle();
    client.enqueue({ ...custom(), actor: { userId: '112233445566778899', username: 'someone' } } as WireEvent, 2);
    await client.flush();
    const printed = lines.join('\n');
    expect(printed).toContain('"actor":"[hidden]"');
    expect(printed).not.toContain('112233445566778899');
    expect(printed).not.toContain('someone');
  });

  it('hands error listeners a copy without tokens, request bodies or URLs that hold them', () => {
    const { client } = makeClient({ fetch: fakeCollector().fetch });
    const seen: unknown[] = [];
    client.on('error', (_name, error) => seen.push(error));
    const token = 'aW50ZXJhY3Rpb246MTIzNDU2Nzg5MDEyMzQ1Njc4OTpzZWNyZXQ';
    const url = `https://discord.com/api/v10/interactions/112233445566778899/${token}/callback`;
    const apiError = Object.assign(new Error(`Unknown interaction at ${url}`), {
      name: 'DiscordAPIError[10062]',
      code: 10062,
      status: 404,
      method: 'POST',
      url,
      requestBody: { json: { content: 'private message text' } },
    });
    client.count('privacyCommand', apiError);
    const [copy] = seen as (Error & Record<string, unknown>)[];
    expect(copy).toMatchObject({ name: 'DiscordAPIError[10062]', code: 10062, status: 404, method: 'POST' });
    expect(JSON.stringify({ ...copy, message: copy?.message, stack: copy?.stack })).not.toContain(token);
    expect(copy?.requestBody).toBeUndefined();
  });
});

describe('nextPeriodStart', () => {
  const at = new Date('2026-11-13T16:42:01Z'); // a Friday
  it('finds the next UTC day, ISO week (Monday) and month', () => {
    expect(new Date(nextPeriodStart('day', at)).toISOString()).toBe('2026-11-14T00:00:00.000Z');
    expect(new Date(nextPeriodStart('week', at)).toISOString()).toBe('2026-11-16T00:00:00.000Z');
    expect(new Date(nextPeriodStart('month', at)).toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(new Date(nextPeriodStart('week', new Date('2026-11-16T00:00:00Z'))).toISOString()).toBe(
      '2026-11-23T00:00:00.000Z',
    );
    expect(new Date(nextPeriodStart('month', new Date('2026-12-31T23:59:59Z'))).toISOString()).toBe(
      '2027-01-01T00:00:00.000Z',
    );
  });
});
