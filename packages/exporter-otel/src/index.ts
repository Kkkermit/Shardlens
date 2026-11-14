/**
 * `@shardlens/exporter-otel`: Shardlens bot-health metrics through the OpenTelemetry metrics API, so they go wherever
 * your MeterProvider sends them (OTLP, Prometheus, a vendor). Works with or without a Shardlens collector. Metrics
 * never carry a user or server attribute.
 *
 * @packageDocumentation
 */
import { type Attributes, type Counter, type Histogram, type Meter, metrics, ValueType } from '@opentelemetry/api';
import {
  DEFAULT_DURATION_BUCKETS,
  EXPORTER_METRICS,
  type ExporterMetricName,
  type MetricLabels,
  type ShardlensExporter,
  translateEvent,
} from '@shardlens/core';

export interface OpenTelemetryExporterOptions {
  /** Meter to create instruments on. Default: `metrics.getMeter('@shardlens/exporter-otel')` from the global API. */
  meter?: Meter | undefined;
  /** Prefix for every instrument name. Default `shardlens.`. */
  prefix?: string | undefined;
  /** Explicit bucket boundaries, in seconds, advised for the response-time and handler histograms. */
  buckets?: readonly number[] | undefined;
}

export { DEFAULT_DURATION_BUCKETS };

const UNITS = { seconds: 's', bytes: 'By', '1': '1' } as const;

/** Creates the exporter. Pass it to `createShardlens(client, { exporters: [it] })`. */
export function openTelemetryExporter(options: OpenTelemetryExporterOptions = {}): ShardlensExporter {
  const meter = options.meter ?? metrics.getMeter('@shardlens/exporter-otel');
  const prefix = options.prefix ?? 'shardlens.';
  const buckets = [...(options.buckets ?? DEFAULT_DURATION_BUCKETS)];

  const counters = new Map<ExporterMetricName, Counter>();
  const histograms = new Map<ExporterMetricName, Histogram>();
  /** Latest gauge values per metric, keyed by their attributes. Read by the observable gauges on each collection. */
  const gaugeValues = new Map<ExporterMetricName, Map<string, { attributes: Attributes; value: number }>>();

  for (const [metric, spec] of Object.entries(EXPORTER_METRICS) as [
    ExporterMetricName,
    (typeof EXPORTER_METRICS)[ExporterMetricName],
  ][]) {
    const name = `${prefix}${metric}`;
    const base = { description: spec.description, unit: UNITS[spec.unit] };
    if (spec.kind === 'counter') {
      counters.set(metric, meter.createCounter(name, { ...base, valueType: ValueType.INT }));
    } else if (spec.kind === 'histogram') {
      histograms.set(
        metric,
        meter.createHistogram(name, {
          ...base,
          valueType: ValueType.DOUBLE,
          advice: { explicitBucketBoundaries: buckets },
        }),
      );
    } else {
      const values = new Map<string, { attributes: Attributes; value: number }>();
      gaugeValues.set(metric, values);
      meter.createObservableGauge(name, { ...base, valueType: ValueType.DOUBLE }).addCallback((result) => {
        for (const { attributes, value } of values.values()) result.observe(value, attributes);
      });
    }
  }

  const sink = {
    add: (metric: ExporterMetricName, labels: MetricLabels, value: number) => {
      if (value > 0) counters.get(metric)?.add(value, labels);
    },
    record: (metric: ExporterMetricName, labels: MetricLabels, value: number) => {
      histograms.get(metric)?.record(value, labels);
    },
    set: (metric: ExporterMetricName, labels: MetricLabels, value: number) => {
      const key = JSON.stringify(labels);
      gaugeValues.get(metric)?.set(key, { attributes: { ...labels }, value });
    },
  };

  return {
    name: 'otel',
    observe(event) {
      translateEvent(event, sink);
    },
  };
}
