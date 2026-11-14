import { createShardlens } from '@shardlens/discordjs';
import { Client, GatewayIntentBits } from 'discord.js';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

export const lens = createShardlens(client, {
  endpoint: process.env.SHARDLENS_URL!,
  apiKey: process.env.SHARDLENS_INGEST_KEY!,
  environment: process.env.NODE_ENV === 'production' ? 'production' : 'staging',
  release: process.env.npm_package_version, // compare versions on the dashboard
  captureOptionValues: ['language', 'difficulty'], // only these options' values are recorded
  sampleRate: { gauge_window: 0.5 }, // very large bots only; counts are re-weighted
  disable: ['process'], // skip CPU and memory gauges
});
