// The same as read.mjs, from a CommonJS project.
const { createShardlensClient } = require('@shardlens/client');

const shardlens = createShardlensClient({
  endpoint: process.env.SHARDLENS_URL,
  apiKey: process.env.SHARDLENS_READ_KEY,
});
const range = JSON.parse(process.env.SIM_RANGE);
Promise.all([
  shardlens.meta(),
  shardlens.commands({ range }),
  shardlens.top({ metric: 'interactions', groupBy: 'command', range, limit: 500 }),
]).then(
  ([meta, commands, top]) => {
    console.log(JSON.stringify({ appId: meta.appId, commands: commands.rows, top: top.rows }));
  },
  (error) => {
    console.error(error);
    process.exitCode = 1;
  },
);
