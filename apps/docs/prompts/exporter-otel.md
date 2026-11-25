# Send this bot's health to OpenTelemetry

You are adding `@shardlens/exporter-otel` to a discord.js bot: it records Shardlens's bot-health metrics (interactions,
response times against Discord's 3-second deadline, REST latency, rate limits, shard pings, memory) through the global
OpenTelemetry `MeterProvider`, to OTLP, a vendor, or anything the project's OpenTelemetry SDK exports to. Everything
you need is here. Read before you edit, change as little as possible and match the project's style.

## Install and wire

Install `@shardlens/discordjs`, `@shardlens/exporter-otel` and `@opentelemetry/api` with the project's package
manager. The project registers the `MeterProvider` itself (with `@opentelemetry/sdk-metrics` and an exporter); if it
has none yet, ask me where its metrics should go before you add one.

```ts
import { createShardlens } from '@shardlens/discordjs';
import { openTelemetryExporter } from '@shardlens/exporter-otel';
import type { Client } from 'discord.js';

declare const client: Client; // the project's own client

// Records through whichever MeterProvider is registered globally. Keep a collector too with endpoint and apiKey (or
// mongodb), or leave them out for metrics only.
createShardlens(client, { exporters: [openTelemetryExporter()] });
```

If `createShardlens` is already in the project, add `exporters: [openTelemetryExporter()]` to its options rather than
calling it twice. Attributes are bounded (command names, routes, shard numbers): never user IDs.

## Tell me when you're done

The files you changed and where the metrics now go. Guide: https://kkkermit.github.io/Shardlens/self-hosting/exporter-only/
