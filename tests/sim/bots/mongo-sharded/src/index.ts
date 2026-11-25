import { fileURLToPath } from 'node:url';
import { ShardingManager } from 'discord.js';

const manager = new ShardingManager(fileURLToPath(new URL('./bot.js', import.meta.url)), {
  token: process.env.DISCORD_TOKEN,
  totalShards: 'auto',
  respawn: true,
});

let stopping = false;

manager.on('shardCreate', (shard) => {
  console.log(`[manager] launched shard ${shard.id}`);
  shard.on('death', () => {
    if (!stopping) console.warn(`[manager] shard ${shard.id} died, respawning`);
  });
});

// Ctrl+C in a terminal hits every process, but systemd/docker only signal the manager, so pass it on
// and wait until each shard has closed its db connection.
async function stop(signal: NodeJS.Signals) {
  if (stopping) return;
  stopping = true;
  console.log(`[manager] ${signal}, stopping ${manager.shards.size} shards`);
  const exited: Promise<unknown>[] = [];
  for (const shard of manager.shards.values()) {
    const child = shard.process;
    if (!child || child.exitCode !== null) continue;
    exited.push(new Promise((resolve) => child.once('exit', resolve)));
    shard.kill();
  }
  await Promise.all(exited);
  console.log('[manager] all shards stopped');
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

await manager.spawn({ timeout: 60_000 });
