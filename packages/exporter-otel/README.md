# @shardlens/exporter-otel

[Shardlens](https://github.com/Kkkermit/Shardlens) bot-health metrics through the OpenTelemetry metrics API, so they
go wherever your MeterProvider sends them (OTLP, Prometheus, a vendor): interactions by command and outcome, response
times against Discord's 3-second deadline, handler errors, REST requests, rate limits, shard state, servers and process
gauges. Works with or without a Shardlens collector. Metrics never carry a user or server attribute.

```sh
npm install @shardlens/exporter-otel @shardlens/discordjs @opentelemetry/api
```

```ts
import { createShardlens } from '@shardlens/discordjs';
import { openTelemetryExporter } from '@shardlens/exporter-otel';

createShardlens(client, { exporters: [openTelemetryExporter()] });
```

The exporter only uses the API: it records through the global MeterProvider your OpenTelemetry SDK registers, even if
the SDK starts after the exporter, or through the `meter` you pass. With the SDK and an OTLP exporter:

```sh
npm install @opentelemetry/sdk-metrics @opentelemetry/exporter-metrics-otlp-http
```

```ts
import { metrics } from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';

// Sends to OTEL_EXPORTER_OTLP_ENDPOINT (default http://localhost:4318) every 60 seconds.
const reader = new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() });
metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));
```

Instruments are named `shardlens.interactions`, `shardlens.interaction_response` and so on, with UCUM units (`s`,
`By`, `{interaction}`): translated to Prometheus they get the same names as `@shardlens/exporter-prometheus`, so the
Grafana dashboard in `deploy/grafana` works with either.

## Links

- [Exporter-only mode](https://kkkermit.github.io/Shardlens/self-hosting/exporter-only/) ·
  [documentation](https://kkkermit.github.io/Shardlens/)
- Using an AI coding agent? Point it at [`llms.txt`](https://kkkermit.github.io/Shardlens/llms.txt), the docs as plain
  text.
- [Source and issues](https://github.com/Kkkermit/Shardlens) · MIT licence · not affiliated with Discord
