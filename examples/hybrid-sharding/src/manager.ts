// The cluster manager spawns cluster processes, each running several shards. Shardlens runs inside each cluster
// (src/bot.ts), never here.
import { fileURLToPath } from 'node:url';
import { ClusterManager } from 'discord-hybrid-sharding';

const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error('Set DISCORD_TOKEN in .env');

const manager = new ClusterManager(fileURLToPath(new URL('./bot.ts', import.meta.url)), {
  token,
  totalShards: 'auto',
  shardsPerClusters: 2,
  mode: 'process',
});

manager.on('clusterCreate', (cluster) => console.log(`Launched cluster ${cluster.id}`));
await manager.spawn({ timeout: -1 });
