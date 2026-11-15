import { metrics } from '@opentelemetry/api';
import { MeterProvider, MetricReader, type ResourceMetrics } from '@opentelemetry/sdk-metrics';
import { EXPORTER_METRICS, uuidv7, type WireEvent } from '@shardlens/core';
import { afterEach, describe, expect, it } from 'vitest';
import { openTelemetryExporter } from '../src/index.js';

/** A reader that only collects when asked. */
class TestReader extends MetricReader {
  protected override async onForceFlush(): Promise<void> {}
  protected override async onShutdown(): Promise<void> {}
}

const ev = (type: string, fields: Record<string, unknown>) =>
  ({ id: uuidv7(), ts: Date.now(), type, ...fields }) as WireEvent;

function sdk() {
  const reader = new TestReader();
  const provider = new MeterProvider({ readers: [reader] });
  const scopes = async () => {
    const { resourceMetrics } = (await reader.collect()) as { resourceMetrics: ResourceMetrics };
    return resourceMetrics.scopeMetrics;
  };
  const collect = async () => (await scopes()).flatMap((s) => s.metrics);
  return { provider, scopes, collect };
}

function setup() {
  const { provider, collect } = sdk();
  const exporter = openTelemetryExporter({ meter: provider.getMeter('test') });
  return { exporter, collect };
}

afterEach(() => {
  metrics.disable();
});

describe('openTelemetryExporter', () => {
  it('records counters and histograms with bounded attributes', async () => {
    const { exporter, collect } = setup();
    exporter.observe(ev('interaction', { kind: 'chat_input', command: 'ticket', outcome: 'ok', ackMs: 400, user: '' }));
    exporter.observe(ev('interaction', { kind: 'chat_input', command: 'ticket', outcome: 'ok', ackMs: 3500 }));
    const all = await collect();

    const interactions = all.find((m) => m.descriptor.name === 'shardlens.interactions');
    expect(interactions?.dataPoints).toHaveLength(1);
    expect(interactions?.dataPoints[0]?.attributes).toEqual({ kind: 'chat_input', command: 'ticket', outcome: 'ok' });
    expect(interactions?.dataPoints[0]?.value).toBe(2);

    const response = all.find((m) => m.descriptor.name === 'shardlens.interaction_response');
    expect(response?.descriptor.unit).toBe('s');
    const point = response?.dataPoints[0]?.value as { count: number; sum: number; buckets: { boundaries: number[] } };
    expect(point.count).toBe(2);
    expect(point.sum).toBeCloseTo(3.9);
    expect(point.buckets.boundaries).toContain(3);
  });

  it('reports the latest gauge values on collection', async () => {
    const { exporter, collect } = setup();
    exporter.observe(ev('gauge_window', { gauges: [{ name: 'shard.ping_ms', shard: 1, value: 80 }] }));
    exporter.observe(ev('gauge_window', { gauges: [{ name: 'shard.ping_ms', shard: 1, value: 40 }] }));
    const ping = (await collect()).find((m) => m.descriptor.name === 'shardlens.shard_ping');
    expect(ping?.dataPoints).toHaveLength(1);
    expect(ping?.dataPoints[0]?.attributes).toEqual({ shard: '1' });
    expect(ping?.dataPoints[0]?.value).toBeCloseTo(0.04);
  });

  it('never exports a user or server ID', async () => {
    const { exporter, collect } = setup();
    exporter.observe(ev('custom', { name: 'ticket_opened', props: {}, user: '', guild: '112233445566778899' }));
    expect(JSON.stringify(await collect())).not.toContain('112233445566778899');
  });

  it('uses UCUM units, with an annotation for counts, so Prometheus names match the Prometheus exporter', async () => {
    const { exporter, collect } = setup();
    exporter.observe(ev('interaction', { kind: 'chat_input', command: 'ping', outcome: 'ok', ackMs: 10 }));
    exporter.observe(
      ev('gauge_window', {
        gauges: [
          { name: 'shard.guilds', shard: 0, value: 3 },
          { name: 'memory.rss_bytes', value: 1024 },
          { name: 'cache.users', value: 9 },
        ],
      }),
    );
    exporter.observe(ev('app_info', { sessionStartRemaining: 996 }));
    const units = Object.fromEntries((await collect()).map((m) => [m.descriptor.name, m.descriptor.unit]));
    expect(units).toMatchObject({
      'shardlens.interactions': '{interaction}',
      'shardlens.interaction_response': 's',
      'shardlens.guilds': '{server}',
      'shardlens.memory': 'By',
      'shardlens.cache_size': '{entry}',
      'shardlens.identify_remaining': '{session}',
    });
    // `1` means a ratio: a Prometheus translator would name a gauge with it `…_ratio`.
    expect(Object.values(units)).not.toContain('1');
    for (const [metric, spec] of Object.entries(EXPORTER_METRICS)) {
      if (spec.unit === '1' && `shardlens.${metric}` in units)
        expect(units[`shardlens.${metric}`]).toMatch(/^\{\w+\}$/);
    }
  });

  it('records through a global MeterProvider registered after the exporter was created', async () => {
    const exporter = openTelemetryExporter();
    exporter.observe(ev('custom', { name: 'early', props: {} }));
    const { provider, scopes } = sdk();
    metrics.setGlobalMeterProvider(provider);
    exporter.observe(ev('custom', { name: 'ticket_opened', props: {} }));
    exporter.observe(ev('gauge_window', { gauges: [{ name: 'shard.ping_ms', shard: 0, value: 50 }] }));

    const [scope] = await scopes();
    expect(scope?.scope.name).toBe('@shardlens/exporter-otel');
    expect(scope?.scope.version).toMatch(/^\d+\.\d+\.\d+/);
    const custom = scope?.metrics.find((m) => m.descriptor.name === 'shardlens.custom_events');
    expect(custom?.dataPoints.map((p) => [p.attributes, p.value])).toEqual([[{ name: 'ticket_opened' }, 1]]);
    const ping = scope?.metrics.find((m) => m.descriptor.name === 'shardlens.shard_ping');
    expect(ping?.dataPoints[0]?.value).toBeCloseTo(0.05);
  });

  it('never throws on events with odd values', () => {
    const { exporter } = setup();
    const odd = [
      ev('interaction', { kind: null, command: 42, outcome: {}, ackMs: Number.NaN, handlerMs: -1, weight: -3 }),
      ev('rest_window', { rows: [{ method: 1, route: {}, status: 'x', count: Number.POSITIVE_INFINITY }] }),
      ev('gauge_window', { gauges: [{ name: 'memory.rss_bytes', value: Number.POSITIVE_INFINITY }, { name: 'x' }] }),
      ev('custom', { name: undefined, weight: Number.MAX_VALUE }),
      ev('no_such_type', {}),
    ];
    for (const event of odd) expect(() => exporter.observe(event)).not.toThrow();
  });
});
