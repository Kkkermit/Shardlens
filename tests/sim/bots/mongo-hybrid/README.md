# helpdesk-bot

Support desk for our Discord servers: `/ticket open|list` (category autocomplete, close button, priority menu),
`/feedback` (a modal), `/report`, plus the **Profile** user menu and **Quote** message menu. Tickets, feedback and
quotes are stored in MongoDB with mongoose.

Runs clustered with [discord-hybrid-sharding](https://www.npmjs.com/package/discord-hybrid-sharding):
`src/index.ts` is the `ClusterManager` (2 processes, shard count from Discord) and `src/cluster.ts` is what each
cluster runs.

```sh
cp .env.example .env   # DISCORD_TOKEN, DATABASE_URL (and DISCORD_CLIENT_ID for deploying)
npm install
npm run build
npm run deploy         # register the slash/context menu commands
npm start
```

The env is checked on startup (`src/env.ts`); the bot won't start with a missing token or a non-MongoDB
`DATABASE_URL`.
