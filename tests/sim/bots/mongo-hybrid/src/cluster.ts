import { createShardlens } from '@shardlens/discordjs';
import { ActivityType, Client, Events, GatewayIntentBits } from 'discord.js';
import { ClusterClient, getInfo } from 'discord-hybrid-sharding';
import { connectDatabase, disconnectDatabase } from './database';
import { env } from './env';
import { onInteraction } from './handlers/interactionCreate';
import { loadCommands } from './handlers/loadCommands';
import './types';

const info = getInfo();

const client = new Client({
  shards: info.SHARD_LIST,
  shardCount: info.TOTAL_SHARDS,
  intents: [GatewayIntentBits.Guilds],
});

client.cluster = new ClusterClient(client);
client.lens = createShardlens(client, { mongodb: env.DATABASE_URL, release: process.env.npm_package_version });
client.commands = loadCommands();

client.once(Events.ClientReady, (c) => {
  console.log(`[Cluster ${c.cluster.id}] Ready as ${c.user.tag}, shards ${info.SHARD_LIST.join(', ')}, ${c.guilds.cache.size} guilds`);
  c.user.setActivity('/ticket open', { type: ActivityType.Watching });
  c.cluster.triggerReady();
});

client.on(Events.InteractionCreate, onInteraction);
client.on(Events.GuildCreate, (guild) => console.log(`[Cluster ${client.cluster.id}] Added to ${guild.name}`));
client.on(Events.GuildDelete, (guild) => console.log(`[Cluster ${client.cluster.id}] Removed from ${guild.id}`));
client.on(Events.Error, (error) => console.error(`[Cluster ${client.cluster.id}] Client error: ${error.message}`));

let closing = false;
async function close(signal: NodeJS.Signals) {
  if (closing) return;
  closing = true;
  console.log(`[Cluster ${client.cluster.id}] ${signal} - closing`);
  await client.lens.shutdown();
  await client.destroy();
  await disconnectDatabase();
  process.exit(0);
}
process.on('SIGINT', close);
process.on('SIGTERM', close);

async function main() {
  await connectDatabase(info.CLUSTER);
  await client.login(env.DISCORD_TOKEN);
}

main().catch((err) => {
  console.error(`[Cluster ${info.CLUSTER}] Failed to start`, err);
  process.exit(1);
});
