// bot.ts: one cluster process with several shards.
import { createShardlens } from '@shardlens/discordjs';
import { Client, GatewayIntentBits } from 'discord.js';
import { ClusterClient } from 'discord-hybrid-sharding';

class ClusteredClient extends Client {
  readonly cluster: ClusterClient<ClusteredClient>;

  constructor() {
    const info = ClusterClient.getInfo();
    super({ intents: [GatewayIntentBits.Guilds], shards: info.SHARD_LIST, shardCount: info.TOTAL_SHARDS });
    this.cluster = new ClusterClient(this); // set before createShardlens: it reads the cluster ID and shard list
  }
}

const client = new ClusteredClient();

createShardlens(client, {
  endpoint: process.env.SHARDLENS_URL!,
  apiKey: process.env.SHARDLENS_INGEST_KEY!,
});

await client.login(process.env.DISCORD_TOKEN);
