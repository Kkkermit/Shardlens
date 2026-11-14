import { createShardlens } from '@shardlens/discordjs';
import { Client, GatewayIntentBits } from 'discord.js';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

createShardlens(client, {
  endpoint: process.env.SHARDLENS_URL!,
  apiKey: process.env.SHARDLENS_INGEST_KEY!,
  mode: 'audit', // only takes effect when the collector is in audit mode too
  auditIncludeProfile: true, // the default: username and avatar with each user ID. false records IDs only
});
