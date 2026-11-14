import { createShardlens } from '@shardlens/discordjs';
import { Client, GatewayIntentBits } from 'discord.js';

// Internal sharding: one process, several shards. One Shardlens instance tags every event with its guild's shard.
const client = new Client({ intents: [GatewayIntentBits.Guilds], shards: 'auto' });

createShardlens(client, {
  endpoint: process.env.SHARDLENS_URL!,
  apiKey: process.env.SHARDLENS_INGEST_KEY!,
});

await client.login(process.env.DISCORD_TOKEN);
