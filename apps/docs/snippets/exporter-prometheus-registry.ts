import { prometheusExporter } from '@shardlens/exporter-prometheus';
import { collectDefaultMetrics, Registry } from 'prom-client';

// Already serving your own /metrics? Put Shardlens's metrics on your registry instead of starting a server.
export const registry = new Registry();
collectDefaultMetrics({ register: registry });
export const prometheus = prometheusExporter({ registry });
