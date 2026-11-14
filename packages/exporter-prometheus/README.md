# @shardlens/exporter-prometheus

[Shardlens](https://github.com/Kkkermit/Shardlens) bot-health metrics in Prometheus format, for Grafana: response
times against Discord's 3-second deadline, interaction errors, REST latency and 429s, shard state and process gauges.
Works with or without a Shardlens collector. Metrics never carry a user or server label.

```sh
npm install @shardlens/exporter-prometheus @shardlens/discordjs prom-client
```

```ts
import { createShardlens } from '@shardlens/discordjs';
import { prometheusExporter } from '@shardlens/exporter-prometheus';

const prometheus = prometheusExporter();
createShardlens(client, { exporters: [prometheus] });
await prometheus.serve({ port: 9464 }); // GET http://127.0.0.1:9464/metrics
```

The metrics server listens on `127.0.0.1` unless you choose another host. Already serving your own `/metrics`? Pass
your `registry` instead of calling `serve()`. A ready-made Grafana dashboard is in the repository under
`deploy/grafana`.

## Links

- [Grafana guide](https://kkkermit.github.io/Shardlens/guides/grafana/) ·
  [exporter-only mode](https://kkkermit.github.io/Shardlens/self-hosting/exporter-only/) ·
  [documentation](https://kkkermit.github.io/Shardlens/)
- Using an AI coding agent? Point it at [`llms.txt`](https://kkkermit.github.io/Shardlens/llms.txt), the docs as plain
  text.
- [Source and issues](https://github.com/Kkkermit/Shardlens) · MIT licence · not affiliated with Discord
