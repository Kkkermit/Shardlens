// One cluster process. Shardlens reads client.cluster (its ID and shard list) to tag events, so set it before
// creating Shardlens. App-wide work (application info, registered commands) runs only in the cluster with shard 0.
import { createShardlens } from '@shardlens/discordjs';
import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import { ClusterClient } from 'discord-hybrid-sharding';

class ClusteredClient extends Client {
  readonly cluster: ClusterClient<ClusteredClient>;

  constructor() {
    const info = ClusterClient.getInfo();
    super({ intents: [GatewayIntentBits.Guilds], shards: info.SHARD_LIST, shardCount: info.TOTAL_SHARDS });
    this.cluster = new ClusterClient(this);
  }
}

const client = new ClusteredClient();

const lens = createShardlens(client, {
  endpoint: process.env.SHARDLENS_URL ?? 'http://localhost:8080',
  apiKey: process.env.SHARDLENS_INGEST_KEY ?? '',
});

client.on(
  Events.InteractionCreate,
  lens.wrap(async (interaction) => {
    if (interaction.isChatInputCommand() && interaction.commandName === 'ping') {
      const where = `cluster ${client.cluster.id}, shards ${client.cluster.shardList.join(', ')}`;
      await interaction.reply({ content: `Pong from ${where}`, flags: MessageFlags.Ephemeral });
    }
  }),
);

// Ctrl+C sends SIGINT to every cluster; the manager passes on its own SIGTERM (src/manager.ts). Flush before exiting.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await lens.shutdown({ timeoutMs: 2_000 });
    await client.destroy();
    process.exit(0);
  });
}

await client.login(process.env.DISCORD_TOKEN);
