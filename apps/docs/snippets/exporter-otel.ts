import { createShardlens } from '@shardlens/discordjs';
import { openTelemetryExporter } from '@shardlens/exporter-otel';
import { Client, GatewayIntentBits } from 'discord.js';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Uses the global MeterProvider your OpenTelemetry SDK registered (OTLP, Prometheus, a vendor…).
createShardlens(client, {
  endpoint: process.env.SHARDLENS_URL, // optional: keep sending to a collector too
  apiKey: process.env.SHARDLENS_INGEST_KEY,
  exporters: [openTelemetryExporter()],
});

await client.login(process.env.DISCORD_TOKEN);
