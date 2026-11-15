// Loaded with `node --require` (or NODE_OPTIONS, so a ShardingManager's shard processes load it too), before the
// bot's own code, which stays unchanged:
// - points discord.js's REST API at the fake Discord in SIM_API (the gateway URL then comes from GET /gateway/bot);
// - moves listening ports as SIM_LISTEN says ("8091:8601,…"). The fixtures hard-code their embedded collector's port,
//   and a run must be able to use other ports than another run on the same machine.
const net = require('node:net');
const { createRequire } = require('node:module');
const { join } = require('node:path');

const fromBot = createRequire(join(process.cwd(), 'package.json'));
const fromDiscordJs = createRequire(fromBot.resolve('discord.js'));
fromDiscordJs('@discordjs/rest').DefaultRestOptions.api = process.env.SIM_API;
// ShardingManager's `totalShards: 'auto'` asks Discord itself, at the frozen `RouteBases.api`, through discord.js's own
// undici. discord.js takes `fetch` from undici when it loads, which is after this.
const undici = fromDiscordJs('undici');
const undiciFetch = undici.fetch;
undici.fetch = (input, init) =>
  undiciFetch(
    typeof input === 'string' ? input.replace(/^https:\/\/discord\.com\/api(?=\/)/, process.env.SIM_API) : input,
    init,
  );

const moved = new Map(
  (process.env.SIM_LISTEN ?? '')
    .split(',')
    .filter(Boolean)
    .map((pair) => pair.split(':').map(Number)),
);
const to = (port) => moved.get(Number(port)) ?? port;
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (options, ...rest) {
  if (typeof options === 'number') return listen.call(this, to(options), ...rest);
  if (options?.port !== undefined) return listen.call(this, { ...options, port: to(options.port) }, ...rest);
  return listen.call(this, options, ...rest);
};
