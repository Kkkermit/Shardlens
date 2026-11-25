# shardbot

A small fun bot: `/ping`, `/server`, `/stats`, `/echo` and `/roulette`. It runs sharded with discord.js's
`ShardingManager` (`src/index.ts` starts one `dist/bot.js` process per shard), and every shard keeps its own
connection to MongoDB (`src/db.ts`) for echo counts and roulette spins.

```sh
cp .env.example .env      # DISCORD_TOKEN, CLIENT_ID, MONGODB_URL
npm install
npm run build
npm run deploy            # registers the slash commands, again whenever a command's options change
npm start
```
