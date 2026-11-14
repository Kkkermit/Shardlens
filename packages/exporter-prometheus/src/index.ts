/**
 * `@shardlens/exporter-prometheus`: Shardlens bot-health metrics in Prometheus format, for Grafana. Works with or
 * without a Shardlens collector. Metrics never carry a user or server label.
 *
 * @packageDocumentation
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  DEFAULT_DURATION_BUCKETS,
  EXPORTER_METRICS,
  type ExporterMetricName,
  type MetricLabels,
  type ShardlensExporter,
  translateEvent,
} from '@shardlens/core';
import { Counter, Gauge, Histogram, Registry } from 'prom-client';

export interface PrometheusExporterOptions {
  /** Registry to register the metrics on. Default: a new registry, so nothing clashes with your own metrics. */
  registry?: Registry | undefined;
  /** Prefix for every metric name. Default `shardlens_`. */
  prefix?: string | undefined;
  /** Bucket boundaries, in seconds, for the response-time and handler histograms. */
  buckets?: readonly number[] | undefined;
}

export interface MetricsServer {
  readonly port: number;
  close(): Promise<void>;
}

export interface PrometheusExporter extends ShardlensExporter {
  /** The registry holding the Shardlens metrics. Merge it with yours, or serve it with {@link PrometheusExporter.serve}. */
  readonly registry: Registry;
  /**
   * Serves `GET /metrics` on its own small HTTP server. Listens on `127.0.0.1` unless you choose another host: put a
   * firewall or reverse proxy in front before exposing it.
   */
  serve(options?: { port?: number | undefined; host?: string | undefined }): Promise<MetricsServer>;
}

export { DEFAULT_DURATION_BUCKETS };

const UNIT_SUFFIX = { seconds: '_seconds', bytes: '_bytes', '1': '' } as const;

/** Prometheus metric name for a Shardlens instrument, following Prometheus naming conventions. */
export function prometheusName(metric: ExporterMetricName, prefix = 'shardlens_'): string {
  const spec = EXPORTER_METRICS[metric];
  return `${prefix}${metric}${UNIT_SUFFIX[spec.unit]}${spec.kind === 'counter' ? '_total' : ''}`;
}

/** Creates the exporter. Pass it to `createShardlens(client, { exporters: [it] })`. */
export function prometheusExporter(options: PrometheusExporterOptions = {}): PrometheusExporter {
  const registry = options.registry ?? new Registry();
  const prefix = options.prefix ?? 'shardlens_';
  const buckets = [...(options.buckets ?? DEFAULT_DURATION_BUCKETS)];

  const counters = new Map<ExporterMetricName, Counter>();
  const histograms = new Map<ExporterMetricName, Histogram>();
  const gauges = new Map<ExporterMetricName, Gauge>();
  const gaugeConfigs = new Map<ExporterMetricName, ConstructorParameters<typeof Gauge>[0]>();
  for (const [metric, spec] of Object.entries(EXPORTER_METRICS) as [
    ExporterMetricName,
    (typeof EXPORTER_METRICS)[ExporterMetricName],
  ][]) {
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

  const sink = {
    add: (metric: ExporterMetricName, labels: MetricLabels, value: number) => {
      if (value > 0) counters.get(metric)?.inc(labels, value);
    },
    record: (metric: ExporterMetricName, labels: MetricLabels, value: number) => {
      histograms.get(metric)?.observe(labels, value);
    },
    set: (metric: ExporterMetricName, labels: MetricLabels, value: number) => {
      let gauge = gauges.get(metric);
      const config = gaugeConfigs.get(metric);
      if (!gauge && config) {
        gauge = new Gauge(config);
        gauges.set(metric, gauge);
      }
      gauge?.set(labels, value);
    },
  };

  const servers = new Set<MetricsServer>();

  return {
    name: 'prometheus',
    registry,
    observe(event) {
      translateEvent(event, sink);
    },
    async serve(serveOptions = {}) {
      const server = createServer((req, res) => {
        if (req.method !== 'GET' || (req.url ?? '/').split('?')[0] !== '/metrics') {
          res.writeHead(404).end();
          return;
        }
        registry.metrics().then(
          (body) => res.writeHead(200, { 'content-type': registry.contentType }).end(body),
          () => res.writeHead(500).end(),
        );
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(serveOptions.port ?? 9464, serveOptions.host ?? '127.0.0.1', () => resolve());
      });
      const handle: MetricsServer = {
        port: (server.address() as AddressInfo).port,
        close: () =>
          new Promise<void>((resolve) => {
            servers.delete(handle);
            server.close(() => resolve());
            server.closeAllConnections();
          }),
      };
      servers.add(handle);
      return handle;
    },
    async shutdown() {
      await Promise.all([...servers].map((s) => s.close()));
    },
  };
}
