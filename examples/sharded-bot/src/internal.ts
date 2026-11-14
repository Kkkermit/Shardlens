// Internal sharding: one process runs every shard. One Shardlens instance tags each event with its guild's shard.
import { createShardlens } from '@shardlens/discordjs';
import { Client, Events, GatewayIntentBits } from 'discord.js';

const client = new Client({ intents: [GatewayIntentBits.Guilds], shards: 'auto' });

const lens = createShardlens(client, {
  endpoint: process.env.SHARDLENS_URL ?? 'http://localhost:8080',
  apiKey: process.env.SHARDLENS_INGEST_KEY ?? '',
});

client.once(Events.ClientReady, (ready) => console.log(`Ready on ${ready.ws.shards.size} shard(s)`));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await lens.shutdown({ timeoutMs: 2_000 });
    await client.destroy();
    process.exit(0);
  });
}

await client.login(process.env.DISCORD_TOKEN);
