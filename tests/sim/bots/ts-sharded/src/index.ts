import { once } from 'node:events';
import { ShardingManager } from 'discord.js';

const manager = new ShardingManager(new URL('./bot.js', import.meta.url).pathname, {
  token: process.env.DISCORD_TOKEN,
  totalShards: 'auto',
});

manager.on('shardCreate', (shard) => console.log(`Launched shard ${shard.id}`));

// A signal sent to the manager alone (docker stop, systemd) never reaches the shards: pass it on, and wait for each
// shard to flush its analytics and exit.
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
