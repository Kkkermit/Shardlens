// What an owner's own dashboard does on its server: ask the collector through the installed client. Prints the
// answers as JSON, for the sim to compare with what the collector's API gives directly.
import { createShardlensClient } from '@shardlens/client';

const shardlens = createShardlensClient({ url: process.env.SHARDLENS_URL, key: process.env.SHARDLENS_READ_KEY });
const range = JSON.parse(process.env.SIM_RANGE);
const [meta, commands, top] = await Promise.all([
  shardlens.meta(),
  shardlens.commands({ range }),
  shardlens.top({ metric: 'interactions', groupBy: 'command', range, limit: 500 }),
]);
console.log(JSON.stringify({ appId: meta.appId, commands: commands.rows, top: top.rows }));
