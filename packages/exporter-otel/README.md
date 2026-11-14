# @shardlens/exporter-otel

[Shardlens](https://github.com/Kkkermit/Shardlens) bot-health metrics through the OpenTelemetry metrics API, so they
go wherever your MeterProvider sends them (OTLP, Prometheus, a vendor). Works with or without a Shardlens collector.
Metrics never carry a user or server attribute.

```sh
npm install @shardlens/exporter-otel @shardlens/discordjs @opentelemetry/api
```

```ts
import { createShardlens } from '@shardlens/discordjs';
import { openTelemetryExporter } from '@shardlens/exporter-otel';

// After your OpenTelemetry SDK has registered a global MeterProvider:
createShardlens(client, { exporters: [openTelemetryExporter()] });
```

## Links

- [Exporter-only mode](https://kkkermit.github.io/Shardlens/self-hosting/exporter-only/) ·
  [documentation](https://kkkermit.github.io/Shardlens/)
- Using an AI coding agent? Point it at [`llms.txt`](https://kkkermit.github.io/Shardlens/llms.txt), the docs as plain
  text.
- [Source and issues](https://github.com/Kkkermit/Shardlens) · MIT licence · not affiliated with Discord
