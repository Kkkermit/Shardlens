// Cloudflare Workers end whatever a request started when the request ends: its timers never fire, and a promise it
// created never settles, also for a later request awaiting it (checked against workerd). These tests stand in for
// that with requests that never get an answer and timers that are never run.
import type { APIInteraction } from 'discord-api-types/v10';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Ctx, month, setup, shutdownLenses, slash } from './helpers.js';

afterEach(async () => {
  vi.useRealTimers();
  await shutdownLenses();
});

const answer = async (_i: APIInteraction, _c: Ctx) => ({ type: 4 as const, data: { content: 'ok' } });

describe('under waitUntil', () => {
  it('keeps recording after the request that asked for settings ended before the answer came', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    // A collector waking up: the first settings request is lost with the request that made it.
    const { collector, lens } = setup(
      {},
      { config: (n) => (n === 0 ? new Promise<Response>(() => undefined) : undefined) },
    );
    const handle = lens.wrapInteractionHandler(answer);

    const first = new Ctx();
    await handle(slash({ data: { id: '445566778899001122', name: 'first', type: 1 } }), first);
    const firstDone = first.settle();
    await vi.advanceTimersByTimeAsync(5_000);
    await firstDone;

    const second = new Ctx();
    await handle(slash({ data: { id: '445566778899001122', name: 'second', type: 1 } }), second);
    const secondDone = second.settle();
    await vi.advanceTimersByTimeAsync(5_000);
    await secondDone;

    expect(collector.configRequests()).toBe(2);
    expect(collector.events('interaction').map((e) => e.command)).toEqual(['second']);
  });

  it('asks for settings again when the collector had no salt for this period (a salt period boundary)', async () => {
    const { collector, lens } = setup({}, { salts: (n) => (n === 0 ? [month(-1)] : [month(0), month(-1)]) });
    const handle = lens.wrapInteractionHandler(answer);
    const first = new Ctx();
    await handle(slash(), first);
    await first.settle();
    expect(collector.events('interaction')).toEqual([]);

    const second = new Ctx();
    await handle(slash(), second);
    await second.settle();
    expect(collector.configRequests()).toBe(2);
    expect(collector.events('interaction')).toHaveLength(1);
    expect(collector.events('interaction')[0]?.user).toMatch(new RegExp(`^h1:${month()}:`));
  });

  it('sends only from inside a request: no flush timer runs between requests', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { collector, lens } = setup();
    const handle = lens.wrapInteractionHandler(answer);
    const first = new Ctx();
    await handle(slash(), first);
    await first.settle();
    const sent = collector.spy.mock.calls.length;

    // Tracked without waitUntil: on Workers a timer flushing it would die with whichever request started it.
    lens.track('between_requests');
    vi.advanceTimersByTime(60_000);
    // Long enough for a flush a timer started to reach the network.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(collector.spy.mock.calls.length).toBe(sent);

    const second = new Ctx();
    await handle(slash(), second);
    await second.settle();
    expect(collector.events('custom').map((e) => e.name)).toEqual(['between_requests']);
    expect(collector.events('interaction')).toHaveLength(2);
  });

  it('backs off while the collector stays unreachable, instead of asking on every request', async () => {
    const { collector, lens } = setup({}, { config: () => Promise.resolve(new Response('down', { status: 503 })) });
    const handle = lens.wrapInteractionHandler(answer);
    for (let i = 0; i < 6; i++) {
      const ctx = new Ctx();
      await handle(slash(), ctx);
      await ctx.settle();
    }
    // The first client, then one replacement; the next waits at least a second.
    expect(collector.configRequests()).toBe(2);
  });

  it('never replaces a client that has no collector to send to', async () => {
    const warnings: string[] = [];
    const { collector, lens } = setup({
      endpoint: undefined,
      apiKey: undefined,
      logger: { warn: (m) => warnings.push(m) },
    });
    const handle = lens.wrapInteractionHandler(answer);
    for (let i = 0; i < 3; i++) {
      const ctx = new Ctx();
      await expect(handle(slash(), ctx)).resolves.toMatchObject({ type: 4 });
      await ctx.settle();
    }
    expect(collector.spy).not.toHaveBeenCalled();
    expect(warnings).toHaveLength(1);
  });
  it('keeps exporters running when a client is replaced, and stops them with the lens', async () => {
    const observed: string[] = [];
    const shutdown = vi.fn();
    const exporter = { name: 'test', observe: (event: { type: string }) => void observed.push(event.type), shutdown };
    const { collector, lens } = setup(
      { exporters: [exporter] },
      { salts: (n) => (n === 0 ? [month(-1)] : [month(0), month(-1)]) },
    );
    const handle = lens.wrapInteractionHandler(answer);
    for (let i = 0; i < 2; i++) {
      const ctx = new Ctx();
      await handle(slash(), ctx);
      await ctx.settle();
    }
    expect(collector.configRequests()).toBe(2);
    expect(shutdown).not.toHaveBeenCalled();
    expect(observed).toEqual(['interaction', 'interaction']);
    await lens.shutdown();
    expect(shutdown).toHaveBeenCalledTimes(1);
  });
});
