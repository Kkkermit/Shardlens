# ts-sharded-bot

The discord.js guide bot (`src/commands/*`, `src/events/*`), sharded with `ShardingManager` (`src/index.ts` spawns
`src/bot.ts`).

    cp .env.example .env
    npm install && npm run build
    npm run deploy
    npm start

Usage analytics: set `SHARDLENS_URL` and `SHARDLENS_INGEST_KEY` (see Shardlens) in `.env`; without them the bot runs as before.
