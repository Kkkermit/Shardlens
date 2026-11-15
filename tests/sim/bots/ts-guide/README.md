# ts-guide-bot

Support-ticket bot following the discord.js guide layout: `src/commands/*`, `src/events/*`.

    cp .env.example .env
    npm install && npm run build && npm start

Analytics (optional): set `SHARDLENS_URL` and `SHARDLENS_INGEST_KEY` in `.env` to send usage stats to your [Shardlens](https://kkkermit.github.io/Shardlens/) collector; leave them empty and nothing is recorded.
