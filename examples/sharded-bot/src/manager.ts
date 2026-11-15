// The manager only spawns shard processes. Shardlens runs inside each shard (src/bot.ts), never here.
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { ShardingManager } from 'discord.js';

const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error('Set DISCORD_TOKEN in .env');

const manager = new ShardingManager(fileURLToPath(new URL('./bot.ts', import.meta.url)), {
  token,
  totalShards: 'auto',
});

manager.on('shardCreate', (shard) => console.log(`Launched shard ${shard.id}`));

// A signal sent to the manager alone (`docker stop`, systemd) never reaches the shard processes, and they are killed
// without flushing once the manager exits. Pass it on, and wait for every shard to finish.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await Promise.all(
      manager.shards.map((shard) => {
        const child = shard.process;
        if (!child || child.exitCode !== null) return undefined;
        shard.kill();
        return once(child, 'exit');
      }),
    );
    process.exit(0);
  });
}

await manager.spawn();
