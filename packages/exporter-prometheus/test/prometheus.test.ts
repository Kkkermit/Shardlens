import { ShardlensClient, uuidv7, type WireEvent } from '@shardlens/core';
import { Registry } from 'prom-client';
import { afterEach, describe, expect, it } from 'vitest';
import { prometheusExporter, prometheusName } from '../src/index.js';

const ev = (type: string, fields: Record<string, unknown>) =>
  ({ id: uuidv7(), ts: Date.now(), type, ...fields }) as WireEvent;

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((f) => f()));
});

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

  it('the bundled Grafana dashboard only queries metrics this exporter produces', async () => {
    const { readFileSync } = await import('node:fs');
    const { EXPORTER_METRICS } = await import('@shardlens/core');
    const dashboard = JSON.parse(
      readFileSync(new URL('../../../deploy/grafana/shardlens-dashboard.json', import.meta.url), 'utf8'),
    ) as { panels: { title: string; targets: { expr: string }[] }[] };
    const known = new Set(
      Object.keys(EXPORTER_METRICS).flatMap((m) => {
        const name = prometheusName(m as keyof typeof EXPORTER_METRICS);
        return [name, `${name}_bucket`, `${name}_count`, `${name}_sum`];
      }),
    );
    const used = dashboard.panels.flatMap((p) => p.targets.flatMap((t) => t.expr.match(/shardlens_\w+/g) ?? []));
    expect(used.length).toBeGreaterThan(10);
    expect(used.filter((name) => !known.has(name))).toEqual([]);
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
});
