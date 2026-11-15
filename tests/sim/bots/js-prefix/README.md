# js-prefix-bot

A small moderation bot. Prefix commands (`!ping`, `!ban`, `!warn`, `!prefix`) with per-server prefixes and aliases,
plus `/info` and `/broken` slash commands.

    cp .env.example .env   # add DISCORD_TOKEN and DISCORD_APP_ID
    npm install
    npm start

Analytics run inside the bot with Shardlens (embedded mode): the dashboard is at http://127.0.0.1:8091, the sign-in key
is `readKey` in `data/shardlens/secrets.json`, and every event is also copied to `data/shardlens-events.db` (SQLite).
