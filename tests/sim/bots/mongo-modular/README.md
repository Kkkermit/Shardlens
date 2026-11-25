# nexus

Community bot for our servers, rewritten in v4 around a small modular core so features can be added without
touching each other.

- **core**: `/ping` and `!ping` (alias `!pong`), `!help`
- **settings**: per-server prefix (`!prefix`, `/settings`), stored in MongoDB
- **polls**: `/poll` with Yes/No buttons, one vote per person
- **stats**: `!stats` (alias `!st`) and the **Stats** user menu

## Layout

```
src/
  core/        config (env → frozen object), DI container, logger, event bus, errors, error handler, lifecycle
  database/    one shared MongoClient and the repositories
  framework/   command registry + middleware (guild only, permissions, cooldowns), component router, gateway
  modules/     one folder per feature: commands, components, events, service, module.ts
```

A module registers its services in the container (`register`) and its commands, components and bus handlers in
`setup`; add it to `src/modules/index.ts`. Every command and component error goes through `core/error-handler.ts`.
Shards run inside the one process (`shards: 'auto'`).

## Running

```sh
cp .env.example .env    # DISCORD_TOKEN and MONGO_CONNECTION_STRING at least
npm install
npm run build
npm start
```

Slash commands are synced on startup (`SYNC_COMMANDS=false` to skip, `DEV_GUILD_ID` to sync to one server). Server
settings live in the `guild_settings` collection; polls in `polls` and `poll_votes`.
