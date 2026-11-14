import { createShardlens } from '@shardlens/discordjs';
import { Client, GatewayIntentBits } from 'discord.js';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

createShardlens(client, {
  endpoint: process.env.SHARDLENS_URL!, // https://stats.example.com
  apiKey: process.env.SHARDLENS_INGEST_KEY!, // slk_ingest_…
});

await client.login(process.env.DISCORD_TOKEN);
