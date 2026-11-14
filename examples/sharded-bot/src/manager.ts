// The manager only spawns shard processes. Shardlens runs inside each shard (src/bot.ts), never here.
import { fileURLToPath } from 'node:url';
import { ShardingManager } from 'discord.js';

const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error('Set DISCORD_TOKEN in .env');

const manager = new ShardingManager(fileURLToPath(new URL('./bot.ts', import.meta.url)), {
  token,
  totalShards: 'auto',
});

manager.on('shardCreate', (shard) => console.log(`Launched shard ${shard.id}`));
await manager.spawn();
