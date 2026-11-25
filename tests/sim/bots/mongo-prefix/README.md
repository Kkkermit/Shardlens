# modbot

Moderation bot for my servers. Prefix commands (`!ping`, `!ban`, `!warn`, `!warnings`, `!prefix`, `!help`) with a
custom prefix per server, plus `/info` and a leftover `/broken` slash command. Prefixes, warnings and ban cases are
stored in MongoDB with mongoose.

## Setup

1. `npm install`
2. copy `.env.example` to `.env` and fill in `DISCORD_TOKEN` and `MONGO_URI`
3. turn on the **Message Content** intent for the bot in the developer portal
4. `npm start`

Slash commands are registered when the bot starts. Change a server's prefix with `!prefix <new>` (needs Manage
Server); ping the bot if you forgot it.

Analytics: [Shardlens](https://kkkermit.github.io/Shardlens/), stored in this bot's MongoDB (collections prefixed
`shardlens_`). Run `npx shardlens dashboard` to see them.
