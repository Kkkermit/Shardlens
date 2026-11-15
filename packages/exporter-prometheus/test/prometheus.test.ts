import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { EXPORTER_METRICS, type ExporterMetricName, ShardlensClient, uuidv7, type WireEvent } from '@shardlens/core';
import { Counter, Registry } from 'prom-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prometheusExporter, prometheusName } from '../src/index.js';

const ev = (type: string, fields: Record<string, unknown>) =>
  ({ id: uuidv7(), ts: Date.now(), type, ...fields }) as WireEvent;

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(cleanup.splice(0).map((f) => f()));
});

/** Holds a port, like another process of the bot would. */
async function occupyPort(): Promise<{ port: number; release: () => Promise<void> }> {
  const blocker: Server = createServer();
  await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const address = blocker.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { port, release: () => new Promise<void>((resolve) => blocker.close(() => resolve())) };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('prometheusExporter', () => {
  it('follows Prometheus naming: _total for counters, unit suffixes', () => {
    expect(prometheusName('interactions')).toBe('shardlens_interactions_total');
    expect(prometheusName('interaction_response')).toBe('shardlens_interaction_response_seconds');
    expect(prometheusName('memory', 'bot_')).toBe('bot_memory_bytes');
    expect(prometheusName('guilds')).toBe('shardlens_guilds');
  });

  it('turns events into counters, histograms and gauges', async () => {
    const exporter = prometheusExporter();
    exporter.observe(ev('interaction', { kind: 'chat_input', command: 'ticket', outcome: 'ok', ackMs: 400 }));
    exporter.observe(ev('interaction', { kind: 'chat_input', command: 'ticket', outcome: 'error', ackMs: 4200 }));
    exporter.observe(ev('gauge_window', { gauges: [{ name: 'shard.guilds', shard: 0, value: 812 }] }));
    const text = await exporter.registry.metrics();
    expect(text).toContain('shardlens_interactions_total{kind="chat_input",command="ticket",outcome="ok"} 1');
    expect(text).toContain('shardlens_interactions_total{kind="chat_input",command="ticket",outcome="error"} 1');
    expect(text).toContain(
      'shardlens_interaction_response_seconds_bucket{le="3",kind="chat_input",command="ticket"} 1',
    );
    expect(text).toContain('shardlens_interaction_response_seconds_count{kind="chat_input",command="ticket"} 2');
    expect(text).toContain('shardlens_guilds{shard="0"} 812');
  });

  it('reports a gauge only once it has a value, so a shard without the number does not report 0', async () => {
    const exporter = prometheusExporter();
    expect(await exporter.registry.metrics()).not.toContain('shardlens_identify_remaining');
    exporter.observe(ev('app_info', { sessionStartRemaining: 987 }));
    expect(await exporter.registry.metrics()).toContain('shardlens_identify_remaining 987');
  });

  it('uses its own registry unless given one', async () => {
    const shared = new Registry();
    const exporter = prometheusExporter({ registry: shared, prefix: 'mybot_' });
    exporter.observe(ev('custom', { name: 'ticket_opened', props: {} }));
    expect(await shared.metrics()).toContain('mybot_custom_events_total{name="ticket_opened"} 1');
  });

  it('serves /metrics on localhost and 404s everything else', async () => {
    const exporter = prometheusExporter();
    exporter.observe(ev('rate_limit', { scope: 'shared' }));
    const server = await exporter.serve({ port: 0 });
    cleanup.push(() => server.close());
    const ok = await fetch(`http://127.0.0.1:${server.port}/metrics`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toContain('text/plain');
    expect(await ok.text()).toContain('shardlens_ratelimits_total{scope="shared"} 1');
    expect((await fetch(`http://127.0.0.1:${server.port}/`)).status).toBe(404);
  });

  it('the bundled Grafana dashboard only queries metrics and labels this exporter produces', () => {
    const dashboard = JSON.parse(
      readFileSync(new URL('../../../deploy/grafana/shardlens-dashboard.json', import.meta.url), 'utf8'),
    ) as { panels: { title: string; targets: { expr: string; legendFormat?: string }[] }[] };
    const metrics = new Map<string, readonly string[]>();
    for (const metric of Object.keys(EXPORTER_METRICS) as ExporterMetricName[]) {
      const name = prometheusName(metric);
      const { labels, kind } = EXPORTER_METRICS[metric];
      metrics.set(name, labels);
      if (kind === 'histogram') {
        metrics.set(`${name}_bucket`, [...labels, 'le']);
        for (const part of ['_count', '_sum']) metrics.set(`${name}${part}`, labels);
      }
    }
    // Prometheus adds these to every scraped series.
    const scrape = ['job', 'instance'];
    const targets = dashboard.panels.flatMap((p) => p.targets.map((t) => ({ ...t, title: p.title })));
    expect(targets.length).toBeGreaterThan(20);
    for (const { expr, legendFormat, title } of targets) {
      const used = expr.match(/shardlens_\w+/g) ?? [];
      expect(
        used.filter((name) => !metrics.has(name)),
        title,
      ).toEqual([]);
      const allowed = new Set([...scrape, ...used.flatMap((name) => metrics.get(name) ?? [])]);
      const labels = [
        ...[...expr.matchAll(/by \(([^)]*)\)/g)].flatMap((m) => (m[1] ?? '').split(',').map((l) => l.trim())),
        ...[...expr.matchAll(/(\w+)(?:=~|!=|!~|=)"/g)].map((m) => m[1]),
        ...[...(legendFormat ?? '').matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]),
      ];
      expect(
        labels.filter((l) => !allowed.has(l ?? '')),
        title,
      ).toEqual([]);
      // Every selector is scoped to the dashboard's job variable, so two bots on one Prometheus don't add up.
      expect(used.length, title).toBe((expr.match(/shardlens_\w+\{job=~"\$job"/g) ?? []).length);
    }
  });

  it('works as an exporter-only Shardlens client, with no collector', async () => {
    const exporter = prometheusExporter();
    const client = new ShardlensClient({ sdk: { name: 'test', version: '0' }, exporters: [exporter] });
    cleanup.push(() => client.shutdown({ timeoutMs: 50 }));
    client.enqueueWithUser('112233445566778899', Date.now(), 3, (user) =>
      ev('interaction', { kind: 'chat_input', command: 'help', outcome: 'ok', user }),
    );
    const text = await exporter.registry.metrics();
    expect(text).toContain('shardlens_interactions_total{kind="chat_input",command="help",outcome="ok"} 1');
    expect(text).not.toContain('112233445566778899');
  });

  it('never rejects or throws when the port is taken, and serves once it is free', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const taken = await occupyPort();
    const exporter = prometheusExporter();
    cleanup.push(() => exporter.shutdown?.() ?? Promise.resolve());

    const server = await exporter.serve({ port: taken.port });
    const second = await exporter.serve({ port: taken.port });
    expect(server.port).toBe(0);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0]?.[0])).toContain('EADDRINUSE');

    await second.close();
    await taken.release();
    vi.advanceTimersByTime(10_000);
    for (let i = 0; i < 100 && server.port === 0; i++) await tick();
    expect(server.port).toBe(taken.port);
    vi.useRealTimers();
    exporter.observe(ev('rate_limit', { scope: 'global' }));
    expect(await (await fetch(`http://127.0.0.1:${server.port}/metrics`)).text()).toContain(
      'shardlens_ratelimits_total{scope="global"} 1',
    );
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('gives up on a host it cannot listen on, without throwing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const exporter = prometheusExporter();
    // TEST-NET-3: never an address of this machine.
    const server = await exporter.serve({ port: 0, host: '203.0.113.7' });
    expect(server.port).toBe(0);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/can't serve metrics on 203\.0\.113\.7:0 \(E[A-Z]+\)\.$/);
    await exporter.shutdown?.();
  });

  it('closes its servers on shutdown', async () => {
    const exporter = prometheusExporter();
    const server = await exporter.serve({ port: 0 });
    const port = server.port;
    await exporter.shutdown?.();
    await expect(fetch(`http://127.0.0.1:${port}/metrics`)).rejects.toThrow();
  });

  it('keeps at most 1,000 values per label, so names built from IDs cannot grow the registry without limit', async () => {
    const exporter = prometheusExporter();
    for (let i = 0; i < 5_000; i++) {
      exporter.observe(ev('custom', { name: `vote_${i}`, props: {} }));
      exporter.observe(ev('interaction', { kind: 'chat_input', command: `tag${i}`, outcome: i % 2 ? 'ok' : 'error' }));
    }
    const text = await exporter.registry.metrics();
    const custom = text.split('\n').filter((l) => l.startsWith('shardlens_custom_events_total{'));
    expect(custom).toHaveLength(1_001);
    expect(text).toContain('shardlens_custom_events_total{name="(other)"} 4000');
    // Labels with few values keep them.
    expect(text).toContain('shardlens_interactions_total{kind="chat_input",command="(other)",outcome="ok"} 2000');
    expect(text).toContain('shardlens_interactions_total{kind="chat_input",command="(other)",outcome="error"} 2000');
    expect(text).toContain('shardlens_interactions_total{kind="chat_input",command="tag999",outcome="ok"} 1');
  });

  it('replaces options it cannot use with the defaults, with a warning, instead of throwing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const clashing = new Registry();
    new Counter({ name: 'shardlens_interactions_total', help: 'mine', registers: [clashing] });

    const exporter = prometheusExporter({ prefix: 'my-bot_', buckets: [3, 1], registry: clashing });
    exporter.observe(ev('interaction', { kind: 'chat_input', command: 'help', outcome: 'ok', ackMs: 2500 }));
    expect(exporter.registry).not.toBe(clashing);
    const text = await exporter.registry.metrics();
    expect(text).toContain('shardlens_interactions_total{kind="chat_input",command="help",outcome="ok"} 1');
    expect(text).toContain('shardlens_interaction_response_seconds_bucket{le="3",kind="chat_input",command="help"} 1');
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
      expect.stringContaining('prefix'),
      expect.stringContaining('buckets'),
      expect.stringContaining('already has a metric named shardlens_interactions_total'),
    ]);
    expect(prometheusExporter({ registry: {} as Registry }).registry).toBeInstanceOf(Registry);
  });

  it('never throws on events with odd values', async () => {
    const exporter = prometheusExporter();
    const odd = [
      ev('interaction', { kind: null, command: 42, outcome: {}, ackMs: Number.NaN, handlerMs: -1, weight: -3 }),
      ev('interaction', { outcome: 'error', errorClass: 7 }),
      ev('rest_window', { rows: 'nope', invalid: null }),
      ev('rest_window', { rows: [{ method: 1, route: {}, status: 'x', count: Number.POSITIVE_INFINITY }] }),
      ev('gauge_window', { gauges: [{ name: 'memory.rss_bytes', value: Number.POSITIVE_INFINITY }, { name: 'x' }] }),
      ev('app_info', { sessionStartRemaining: '5' }),
      ev('custom', { name: undefined, weight: Number.MAX_VALUE }),
      ev('no_such_type', {}),
    ];
    for (const event of odd) expect(() => exporter.observe(event)).not.toThrow();
    await expect(exporter.registry.metrics()).resolves.toContain('shardlens_interactions_total');
  });
});
