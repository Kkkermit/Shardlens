/**
 * `@shardlens/exporter-otel`: Shardlens bot-health metrics through the OpenTelemetry metrics API, so they go wherever
 * your MeterProvider sends them (OTLP, Prometheus, a vendor). Works with or without a Shardlens collector. Metrics
 * never carry a user or server attribute.
 *
 * @packageDocumentation
 */
import {
  type Attributes,
  type Counter,
  type Histogram,
  type Meter,
  type MeterProvider,
  metrics,
  ValueType,
} from '@opentelemetry/api';
import {
  DEFAULT_DURATION_BUCKETS,
  EXPORTER_METRICS,
  type ExporterMetricName,
  type MetricLabels,
  type ShardlensExporter,
  translateEvent,
} from '@shardlens/core';

/** Options for {@link openTelemetryExporter}. */
export interface OpenTelemetryExporterOptions {
  /**
   * Meter to create instruments on. Default: a `@shardlens/exporter-otel` meter from the global MeterProvider, also
   * when your OpenTelemetry SDK registers it after the exporter was created.
   */
  meter?: Meter | undefined;
  /** Prefix for every instrument name. Default `shardlens.`. */
  prefix?: string | undefined;
  /** Explicit bucket boundaries, in seconds, advised for the response-time and handler histograms. */
  buckets?: readonly number[] | undefined;
}

export { DEFAULT_DURATION_BUCKETS };

declare const __EXPORTER_VERSION__: string | undefined;
const SCOPE = '@shardlens/exporter-otel';
const VERSION = typeof __EXPORTER_VERSION__ === 'string' ? __EXPORTER_VERSION__ : '0.0.0-dev';

type CountMetric = {
  [M in ExporterMetricName]: (typeof EXPORTER_METRICS)[M]['unit'] extends '1' ? M : never;
}[ExporterMetricName];

/**
 * What each count counts, as a UCUM annotation. OpenTelemetry's unit `1` means a ratio: Prometheus translators name a
 * gauge with it `…_ratio` (`shardlens_guilds_ratio`), while `{server}` adds no suffix.
 */
const COUNTED: Record<CountMetric, string> = {
  interactions: '{interaction}',
  interaction_errors: '{error}',
  rest_requests: '{request}',
  rest_invalid_requests: '{request}',
  ratelimits: '{rate_limit}',
  shard_events: '{event}',
  guild_events: '{event}',
  custom_events: '{event}',
  entitlements: '{event}',
  guilds: '{server}',
  cache_size: '{entry}',
  identify_remaining: '{session}',
};
const UCUM = { seconds: 's', bytes: 'By' } as const;

function unitOf(metric: ExporterMetricName): string {
  const unit = EXPORTER_METRICS[metric].unit;
  return unit === '1' ? COUNTED[metric as CountMetric] : UCUM[unit];
}

type GaugeValues = Map<string, { attributes: Attributes; value: number }>;

interface Instruments {
  counters: Map<ExporterMetricName, Counter>;
  histograms: Map<ExporterMetricName, Histogram>;
}

/** Creates the exporter. Pass it to `createShardlens(client, { exporters: [it] })`. */
export function openTelemetryExporter(options: OpenTelemetryExporterOptions = {}): ShardlensExporter {
  const prefix = options.prefix ?? 'shardlens.';
  const buckets = [...(options.buckets ?? DEFAULT_DURATION_BUCKETS)];
  const names = Object.keys(EXPORTER_METRICS) as ExporterMetricName[];
  /** Latest gauge values per metric, keyed by their attributes. Read by the observable gauges on each collection. */
  const gaugeValues = new Map<ExporterMetricName, GaugeValues>(
    names.filter((m) => EXPORTER_METRICS[m].kind === 'gauge').map((m) => [m, new Map()]),
  );

  const create = (meter: Meter): Instruments => {
    const instruments: Instruments = { counters: new Map(), histograms: new Map() };
    for (const metric of names) {
      const spec = EXPORTER_METRICS[metric];
      const name = `${prefix}${metric}`;
      const base = { description: spec.description, unit: unitOf(metric) };
      if (spec.kind === 'counter') {
        instruments.counters.set(metric, meter.createCounter(name, { ...base, valueType: ValueType.INT }));
      } else if (spec.kind === 'histogram') {
        const advice = { explicitBucketBoundaries: buckets };
        instruments.histograms.set(
          metric,
          meter.createHistogram(name, { ...base, valueType: ValueType.DOUBLE, advice }),
        );
      } else {
        const values = gaugeValues.get(metric);
        meter.createObservableGauge(name, { ...base, valueType: ValueType.DOUBLE }).addCallback((result) => {
          for (const { attributes, value } of values?.values() ?? []) result.observe(value, attributes);
        });
      }
    }
    return instruments;
  };

  // The metrics API has no proxy provider: instruments made before the SDK registered its MeterProvider would stay
  // no-ops for good, so without a `meter` option the global provider is looked up again on each event.
  let provider: MeterProvider | undefined;
  let instruments = options.meter ? create(options.meter) : undefined;
  const refresh = () => {
    if (options.meter) return;
    const global = metrics.getMeterProvider();
    if (instruments && global === provider) return;
    provider = global;
    instruments = create(global.getMeter(SCOPE, VERSION));
  };

  const sink = {
    add: (metric: ExporterMetricName, labels: MetricLabels, value: number) => {
      if (value > 0) instruments?.counters.get(metric)?.add(value, labels);
    },
    record: (metric: ExporterMetricName, labels: MetricLabels, value: number) => {
      instruments?.histograms.get(metric)?.record(value, labels);
    },
    set: (metric: ExporterMetricName, labels: MetricLabels, value: number) => {
      gaugeValues.get(metric)?.set(JSON.stringify(labels), { attributes: { ...labels }, value });
    },
  };

  return {
    name: 'otel',
    observe(event) {
      refresh();
      translateEvent(event, sink);
    },
  };
}
