import { createShardlens } from '@shardlens/discordjs';
import { Client, GatewayIntentBits } from 'discord.js';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

createShardlens(client, {
  mongodb: {
    uri: process.env.MONGODB_URI!,
    // Serves the dashboard from the bot. It logs a one-time sign-in link when it starts.
    dashboard: { port: 8080 },
  },
});

await client.login(process.env.DISCORD_TOKEN);
