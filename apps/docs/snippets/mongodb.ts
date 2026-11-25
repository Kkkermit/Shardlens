import { createShardlens } from '@shardlens/discordjs';
import { Client, GatewayIntentBits } from 'discord.js';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// The MongoDB your bot already uses: Shardlens adds collections prefixed shardlens_.
createShardlens(client, { mongodb: process.env.MONGODB_URI });

await client.login(process.env.DISCORD_TOKEN);
