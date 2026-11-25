import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { ClusterManager } from 'discord-hybrid-sharding';
import { env } from './env';

const manager = new ClusterManager(path.join(__dirname, 'cluster.js'), {
  totalShards: 'auto',
  // the VPS has 2 cores, so 2 processes; shards get split between them
  totalClusters: 2,
  mode: 'process',
  token: env.DISCORD_TOKEN,
});

manager.on('clusterCreate', (cluster) => {
  console.log(`[Manager] Launched cluster #${cluster.id} (shards: ${cluster.shardList.join(', ')})`);
});

let shuttingDown = false;
const shutdown = async (signal: NodeJS.Signals) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Manager] Got ${signal}, stopping ${manager.clusters.size} clusters...`);

  await Promise.all(
    [...manager.clusters.values()].map(async (cluster) => {
      // mode is 'process', so each cluster is a child process
      const child = cluster.thread?.process as ChildProcess | null | undefined;
      cluster.kill({ force: true, reason: signal });
      if (child && child.exitCode === null) await once(child, 'exit');
    }),
  );

  console.log('[Manager] Bye');
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

manager.spawn({ timeout: -1 }).catch((err) => {
  console.error('[Manager] Failed to spawn clusters', err);
  process.exit(1);
});
