# Send this bot's health to Prometheus

You are adding `@shardlens/exporter-prometheus` to a discord.js bot: it exposes Shardlens's bot-health metrics
(interactions, response times against Discord's 3-second deadline, REST latency, rate limits, shard pings, memory) in
Prometheus format, with or without a Shardlens collector. Everything you need is here. Read before you edit, change as
little as possible and match the project's style.

## Install and wire

Install `@shardlens/discordjs`, `@shardlens/exporter-prometheus` and `prom-client` with the project's package manager.
If the bot already serves `/metrics` with `prom-client`, pass its registry instead of serving another endpoint:
`prometheusExporter({ registry })`.

```ts
import { createShardlens } from '@shardlens/discordjs';
import { prometheusExporter } from '@shardlens/exporter-prometheus';
import type { Client } from 'discord.js';

declare const client: Client; // the project's own client

const prometheus = prometheusExporter();
// Exporter only: no endpoint or apiKey. Add them (or `mongodb`) to also keep the Shardlens dashboard.
createShardlens(client, { exporters: [prometheus] });

// GET http://127.0.0.1:9464/metrics. With a ShardingManager, each shard's process serves on its own port.
await prometheus.serve({ port: 9464 + (client.shard?.ids[0] ?? 0) });
```

`serve()` listens on 127.0.0.1 and never throws into the bot. Each process has its own metrics: with a
`ShardingManager` the port above differs per shard; with discord-hybrid-sharding use
`9464 + ClusterClient.getInfo().CLUSTER`. Keep the ports off the public internet.

If `createShardlens` is already in the project, add `exporters: [prometheus]` to its options rather than calling it
twice. Labels are bounded (command names, routes, shard numbers): never user IDs.

## Tell me when you're done

The files you changed, the metrics URL and port per process, and a scrape config to add. Guide:
https://kkkermit.github.io/Shardlens/self-hosting/exporter-only/
