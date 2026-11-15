// The cluster manager spawns cluster processes, each running several shards. Shardlens runs inside each cluster
// (src/bot.ts), never here.
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Child, ClusterManager } from 'discord-hybrid-sharding';

const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error('Set DISCORD_TOKEN in .env');

const manager = new ClusterManager(fileURLToPath(new URL('./bot.ts', import.meta.url)), {
  token,
  totalShards: 'auto',
  shardsPerClusters: 2,
  mode: 'process',
});

manager.on('clusterCreate', (cluster) => console.log(`Launched cluster ${cluster.id}`));

// A signal sent to the manager alone (`docker stop`, systemd) never reaches the cluster processes, and they are
// killed without flushing once the manager exits. Pass it on, and wait for every cluster to finish.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await Promise.all(
      [...manager.clusters.values()].map((cluster) => {
        const child = cluster.thread instanceof Child ? cluster.thread.process : null;
        if (!child || child.exitCode !== null) return undefined;
        cluster.kill({ force: true, reason: signal });
        // After kill(): discord-hybrid-sharding removes every listener on the process when it kills it.
        return once(child, 'exit');
      }),
    );
    process.exit(0);
  });
}

await manager.spawn({ timeout: -1 });
