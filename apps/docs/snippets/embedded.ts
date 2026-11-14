import { startEmbeddedCollector } from '@shardlens/collector/embedded';
import { createShardlens } from '@shardlens/discordjs';
import { Client, GatewayIntentBits } from 'discord.js';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// The collector, its jobs and the dashboard, inside this process. Data lives in ./shardlens-data.
const collector = await startEmbeddedCollector({
  dataDir: './shardlens-data',
  appId: process.env.DISCORD_APP_ID!,
  port: 8080, // dashboard on http://127.0.0.1:8080
});

const lens = createShardlens(client, { endpoint: collector.url, apiKey: collector.ingestKey });

console.log(`Shardlens: ${collector.dashboardUrl} (read key in ./shardlens-data/secrets.json)`);
await client.login(process.env.DISCORD_TOKEN);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await lens.shutdown(); // send what is queued while the collector is still there
    await client.destroy();
    await collector.close();
    process.exit(0);
  });
}
