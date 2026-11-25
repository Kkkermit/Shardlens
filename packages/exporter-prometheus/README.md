# @shardlens/exporter-prometheus

[Shardlens](https://github.com/Kkkermit/Shardlens) bot-health metrics in Prometheus format, for Grafana: interactions
by command and outcome, response times against Discord's 3-second deadline, handler errors, REST requests by route and
status, rate limits, shard state, servers and process gauges. Works with or without a Shardlens collector. Metrics
never carry a user or server label.

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

```yaml
# prometheus.yml
scrape_configs:
  - job_name: discord-bot
    static_configs:
      - targets: ['127.0.0.1:9464']
```

- The metrics server listens on `127.0.0.1` unless you pass a `host` (`0.0.0.0` when Prometheus runs in another
  container). It never throws into your bot: if the port is taken, it warns and tries again every 10 seconds.
- A sharded bot with one process per shard or cluster needs one port per process, each a scrape target.
- Already serving your own `/metrics`? Pass your `registry` instead of calling `serve()`.
- Labels are command names, bucketed routes, statuses, shard numbers and your custom event names. Each label keeps at
  most 1,000 values per metric; later new values are counted as `(other)`.
- Using [`@prometheus-io/client`](https://www.npmjs.com/package/@prometheus-io/client), the successor of the deprecated
  `prom-client`? Install it under the name the exporter imports: `npm install prom-client@npm:@prometheus-io/client`.

A ready-made Grafana dashboard is in the repository under `deploy/grafana`.

## Links

- [Exporter-only mode](https://kkkermit.github.io/Shardlens/self-hosting/exporter-only/) ·
  [Grafana guide](https://kkkermit.github.io/Shardlens/guides/grafana/) ·
  [documentation](https://kkkermit.github.io/Shardlens/)
- Using an AI coding agent? Point it at [`exporter-prometheus.md`](https://kkkermit.github.io/Shardlens/prompts/exporter-prometheus.md), a self-contained prompt for adding this package,
  or [`llms.txt`](https://kkkermit.github.io/Shardlens/llms.txt), the docs as plain text.
- [Source and issues](https://github.com/Kkkermit/Shardlens) · MIT licence · not affiliated with Discord
