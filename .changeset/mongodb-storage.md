---
'@shardlens/collector': minor
'@shardlens/discordjs': minor
'shardlens': minor
---

Keep everything in the MongoDB your bot already uses, with nothing else to run. Install `@shardlens/collector` beside
the SDK and give it your connection string:

```ts
createShardlens(client, { mongodb: process.env.MONGODB_URI });
```

The collector then runs inside the bot, on your database (Atlas, its free tier included, a replica set or a single
server, MongoDB 7.0 or newer), in collections prefixed `shardlens_`. Like the SDK, it needs Node.js 22.12 or newer:
the collector package no longer asks for 24.11, embedded mode included. Every process of a sharded bot writes to the same
database and shares one set of keys, and the background jobs run in one process at a time. The dashboard, alerts,
reports, privacy model and every number are the same as on PostgreSQL.

- `npx shardlens dashboard`, run in the bot's folder, finds the connection string in your `.env` and serves the
  dashboard on `127.0.0.1` with a one-time sign-in link.
- `mongodb: { uri, dashboard: { port } }` serves the dashboard from the bot instead, and logs a sign-in link.
- The collector image starts on MongoDB when `DATABASE_URL` is a `mongodb://` or `mongodb+srv://` URL, and then
  needs no session secret or settings key of its own.
- `@shardlens/collector/mongodb` exports `startMongoCollector`, for running it yourself.

The PostgreSQL collector is unchanged and stays the way to go without MongoDB.
