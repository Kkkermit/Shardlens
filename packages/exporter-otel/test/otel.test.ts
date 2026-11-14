import { MeterProvider, MetricReader, type ResourceMetrics } from '@opentelemetry/sdk-metrics';
import { uuidv7, type WireEvent } from '@shardlens/core';
import { describe, expect, it } from 'vitest';
import { openTelemetryExporter } from '../src/index.js';

/** A reader that only collects when asked. */
class TestReader extends MetricReader {
  protected override async onForceFlush(): Promise<void> {}
  protected override async onShutdown(): Promise<void> {}
}

const ev = (type: string, fields: Record<string, unknown>) =>
  ({ id: uuidv7(), ts: Date.now(), type, ...fields }) as WireEvent;

function setup() {
  const reader = new TestReader();
  const provider = new MeterProvider({ readers: [reader] });
  const exporter = openTelemetryExporter({ meter: provider.getMeter('test') });
  const collect = async () => {
    const { resourceMetrics } = (await reader.collect()) as { resourceMetrics: ResourceMetrics };
    return resourceMetrics.scopeMetrics.flatMap((s) => s.metrics);
  };
  return { exporter, collect };
}

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
});
