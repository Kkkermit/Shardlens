# sapphire-bot

A community bot on [Sapphire](https://sapphirejs.dev). Slash and prefix commands, a context menu and poll buttons.
Per-server prefixes are stored in MongoDB.

    cp .env.example .env
    npm install && npm run build && npm start

Analytics: [Shardlens](https://kkkermit.github.io/Shardlens/) runs inside the bot once `DISCORD_APP_ID` is set. Its
dashboard is at http://127.0.0.1:8093 (sign in with `readKey` from `shardlens-data/secrets.json`), and events are also
copied to the `shardlens_events` collection in MongoDB.
