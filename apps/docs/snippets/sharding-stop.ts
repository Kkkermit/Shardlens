import { once } from 'node:events';
import type { ShardingManager } from 'discord.js';

declare const manager: ShardingManager;

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await Promise.all(
      manager.shards.map((shard) => {
        const child = shard.process;
        if (!child || child.exitCode !== null) return undefined;
        shard.kill(); // sends SIGTERM to the shard process
        return once(child, 'exit');
      }),
    );
    process.exit(0);
  });
}
