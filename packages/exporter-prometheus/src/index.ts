/**
 * `@shardlens/exporter-prometheus`: Shardlens bot-health metrics in Prometheus format, for Grafana. Works with or
 * without a Shardlens collector. Metrics never carry a user or server label.
 *
 * @packageDocumentation
 */
import {
  DEFAULT_DURATION_BUCKETS,
  EXPORTER_METRICS,
  type ExporterMetricName,
  type MetricLabels,
  type ShardlensExporter,
  translateEvent,
} from '@shardlens/core';
import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import { type MetricsServer, type ServeOptions, serveMetrics } from './server.js';
import { warn } from './warn.js';

export type { MetricsServer, ServeOptions };

/** Options for {@link prometheusExporter}. Values that can't be used are replaced by the default, with a warning. */
export interface PrometheusExporterOptions {
  /**
   * Registry to register the metrics on. Default: a new registry, so nothing clashes with your own metrics. One that
   * already holds a metric of the same name is not used.
   */
  registry?: Registry | undefined;
  /** Prefix for every metric name. Default `shardlens_`. */
  prefix?: string | undefined;
  /** Bucket boundaries, in seconds and increasing, for the response-time and handler histograms. */
  buckets?: readonly number[] | undefined;
}

/** The exporter returned by {@link prometheusExporter}. */
export interface PrometheusExporter extends ShardlensExporter {
  /** The registry holding the Shardlens metrics. Merge it with yours, or serve it with {@link PrometheusExporter.serve}. */
  readonly registry: Registry;
  /**
   * Serves `GET /metrics` on its own small HTTP server. Listens on `127.0.0.1` unless you choose another host: put a
   * firewall or reverse proxy in front before exposing it. Never rejects: if the port is taken, it warns and tries
   * again every 10 seconds.
   */
  serve(options?: ServeOptions): Promise<MetricsServer>;
}

export { DEFAULT_DURATION_BUCKETS };

const DEFAULT_PREFIX = 'shardlens_';
const UNIT_SUFFIX = { seconds: '_seconds', bytes: '_bytes', '1': '' } as const;
const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

/**
 * Distinct values one label of one metric keeps; later new values are recorded as {@link OTHER}. Labels hold names a
 * bot chooses (commands, custom events, error classes): one that puts an ID in a name, or lets servers name their own
 * commands, must not grow the registry, which lives in the bot's memory, without limit.
 */
const MAX_LABEL_VALUES = 1_000;
const OTHER = '(other)';

/** Prometheus metric name for a Shardlens instrument, following Prometheus naming conventions. */
export function prometheusName(metric: ExporterMetricName, prefix = DEFAULT_PREFIX): string {
  const spec = EXPORTER_METRICS[metric];
  return `${prefix}${metric}${UNIT_SUFFIX[spec.unit]}${spec.kind === 'counter' ? '_total' : ''}`;
}

function usableBuckets(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const list: unknown[] = value;
  const increasing = list.every(
    (b, i) => typeof b === 'number' && Number.isFinite(b) && (i === 0 || b > (list[i - 1] as number)),
  );
  return increasing ? (list as number[]) : undefined;
}

function usableRegistry(given: Registry | undefined, names: readonly string[]): Registry {
  if (given === undefined) return new Registry();
  if (typeof (given as Partial<Registry> | null)?.getSingleMetric !== 'function') {
    warn('registry is not a prom-client Registry; the metrics are on exporter.registry instead.');
    return new Registry();
  }
  const taken = names.find((name) => given.getSingleMetric(name) !== undefined);
  if (taken === undefined) return given;
  warn(`the registry already has a metric named ${taken}; the metrics are on exporter.registry instead.`);
  return new Registry();
}

/** Creates the exporter. Pass it to `createShardlens(client, { exporters: [it] })`. */
export function prometheusExporter(options: PrometheusExporterOptions = {}): PrometheusExporter {
  let prefix = options.prefix ?? DEFAULT_PREFIX;
  if (typeof prefix !== 'string' || (prefix !== '' && !METRIC_NAME.test(prefix))) {
    warn(`prefix must be letters, digits, _ or : (and not start with a digit); using "${DEFAULT_PREFIX}".`);
    prefix = DEFAULT_PREFIX;
  }
  let buckets = usableBuckets(options.buckets);
  if (!buckets) {
    if (options.buckets !== undefined) warn('buckets must be increasing numbers; using the default buckets.');
    buckets = [...DEFAULT_DURATION_BUCKETS];
  }
  const metrics = Object.keys(EXPORTER_METRICS) as ExporterMetricName[];
  const registry = usableRegistry(
    options.registry,
    metrics.map((m) => prometheusName(m, prefix)),
  );

  const counters = new Map<ExporterMetricName, Counter>();
  const histograms = new Map<ExporterMetricName, Histogram>();
  const gauges = new Map<ExporterMetricName, Gauge>();
  const gaugeConfigs = new Map<ExporterMetricName, ConstructorParameters<typeof Gauge>[0]>();
  for (const metric of metrics) {
    const spec = EXPORTER_METRICS[metric];
    const config = {
      name: prometheusName(metric, prefix),
      help: spec.description,
      labelNames: [...spec.labels],
      registers: [registry],
    };
    if (spec.kind === 'counter') counters.set(metric, new Counter(config));
    else if (spec.kind === 'histogram') histograms.set(metric, new Histogram({ ...config, buckets }));
    // Gauges are created on their first value: prom-client reports an unset gauge as 0, which would read as "no
    // identify calls left" on every shard that doesn't own that number.
    else gaugeConfigs.set(metric, config);
  }

  const seen = new Map<ExporterMetricName, Map<string, Set<string>>>();
  const bounded = (metric: ExporterMetricName, labels: MetricLabels): MetricLabels => {
    let byLabel = seen.get(metric);
    if (!byLabel) {
      byLabel = new Map();
      seen.set(metric, byLabel);
    }
    let out: Record<string, string> | undefined;
    for (const [name, value] of Object.entries(labels)) {
      let values = byLabel.get(name);
      if (!values) {
        values = new Set();
        byLabel.set(name, values);
      }
      if (values.has(value)) continue;
      if (values.size < MAX_LABEL_VALUES) values.add(value);
      else {
        out ??= { ...labels };
        out[name] = OTHER;
      }
    }
    return out ?? labels;
  };

  const sink = {
    add: (metric: ExporterMetricName, labels: MetricLabels, value: number) => {
      if (value > 0) counters.get(metric)?.inc(bounded(metric, labels), value);
    },
    record: (metric: ExporterMetricName, labels: MetricLabels, value: number) => {
      histograms.get(metric)?.observe(bounded(metric, labels), value);
    },
    set: (metric: ExporterMetricName, labels: MetricLabels, value: number) => {
      let gauge = gauges.get(metric);
      const config = gaugeConfigs.get(metric);
      if (!gauge && config) {
        gauge = new Gauge(config);
        gauges.set(metric, gauge);
      }
      gauge?.set(bounded(metric, labels), value);
    },
  };

  const servers = new Set<MetricsServer>();

  return {
    name: 'prometheus',
    registry,
    observe(event) {
      translateEvent(event, sink);
    },
    serve(serveOptions = {}) {
      return serveMetrics(registry, serveOptions, servers);
    },
    async shutdown() {
      await Promise.all([...servers].map((s) => s.close()));
    },
  };
}
