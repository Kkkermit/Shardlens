import { once } from 'node:events';
import { Child, type ClusterManager } from 'discord-hybrid-sharding';

declare const manager: ClusterManager;

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await Promise.all(
      [...manager.clusters.values()].map((cluster) => {
        const child = cluster.thread instanceof Child ? cluster.thread.process : null;
        if (!child || child.exitCode !== null) return undefined;
        cluster.kill({ force: true, reason: signal });
        // After kill(): discord-hybrid-sharding removes the process's listeners when it kills it.
        return once(child, 'exit');
      }),
    );
    process.exit(0);
  });
}
