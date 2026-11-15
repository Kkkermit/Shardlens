import { createShardlens } from '@shardlens/discordjs';
import { prometheusExporter } from '@shardlens/exporter-prometheus';
import { Client, GatewayIntentBits } from 'discord.js';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const prometheus = prometheusExporter();
createShardlens(client, { exporters: [prometheus] }); // no endpoint or apiKey: exporter only

// GET http://127.0.0.1:9464/metrics. Under a ShardingManager, shard 1's process serves on 9465, and so on.
await prometheus.serve({ port: 9464 + (client.shard?.ids[0] ?? 0) });

await client.login(process.env.DISCORD_TOKEN);
