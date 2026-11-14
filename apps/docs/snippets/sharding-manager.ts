// manager.ts: one process per shard. Shardlens runs inside each shard process, not in the manager.
import { ShardingManager } from 'discord.js';

const manager = new ShardingManager('./dist/bot.js', { token: process.env.DISCORD_TOKEN!, totalShards: 'auto' });
manager.on('shardCreate', (shard) => console.log(`Launched shard ${shard.id}`));
await manager.spawn();
