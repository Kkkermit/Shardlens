# @shardlens/collector

The [Shardlens](https://github.com/Kkkermit/Shardlens) collector: ingest, rollups, the query API, live updates and the
dashboard. Shardlens is self-hosted, privacy-first analytics and health monitoring for discord.js bots.

## In your bot, on your MongoDB

If your bot uses MongoDB, the collector can run inside it, on the same database: no server, Docker or keys. Install
this package beside the SDK and give the SDK your connection string; it starts the collector for you.

```sh
npm install @shardlens/discordjs @shardlens/collector
```

```ts
createShardlens(client, { mongodb: process.env.MONGODB_URI });
```

`npx shardlens dashboard` in the bot's folder opens the dashboard. To run it yourself, `startMongoCollector` from
`@shardlens/collector/mongodb` does what the SDK does: [On your MongoDB](https://kkkermit.github.io/Shardlens/self-hosting/mongodb/).
It needs Node.js 22.12 or newer, as the SDK does, and MongoDB 7.0 or newer (the server: Atlas runs 8.0).

## Run it with Docker

Without MongoDB, run the collector as a container next to PostgreSQL 16 or newer, behind Caddy for HTTPS. The
[quick start](https://kkkermit.github.io/Shardlens/getting-started/quick-start/) has the whole setup:

```sh
npx shardlens init --domain stats.example.com --app-id <your application ID>
cd shardlens && docker compose up -d
```

The image is `ghcr.io/kkkermit/shardlens-collector`. It is configured with
[environment variables](https://kkkermit.github.io/Shardlens/reference/environment/), applies its database migrations
when it starts, and serves the dashboard on the same port as the API.

The dashboard is optional. With `SHARDLENS_DASHBOARD=off` (`npx shardlens init … --dashboard own` or `none`) the
collector serves its API only, and [`@shardlens/client`](https://www.npmjs.com/package/@shardlens/client) reads every
number into a dashboard of your own:
[Choose your setup](https://kkkermit.github.io/Shardlens/getting-started/choose-your-setup/).

## Embedded mode

This package also runs the whole collector inside a small bot's own process, on an in-process PostgreSQL
([PGlite](https://pglite.dev/)) stored in one folder. No Docker and no database server.

```sh
npm install @shardlens/collector @electric-sql/pglite @shardlens/discordjs
```

```ts
import { startEmbeddedCollector } from '@shardlens/collector/embedded';
import { createShardlens } from '@shardlens/discordjs';

const collector = await startEmbeddedCollector({ dataDir: './shardlens-data', appId: '123456789012345678' });
createShardlens(client, { endpoint: collector.url, apiKey: collector.ingestKey });
// Dashboard: collector.dashboardUrl, sign in with collector.readKey
// Or pass `dashboard: false` and read the numbers with @shardlens/client, collector.url and collector.readKey
```

Keep the data folder private and out of version control: it holds the database and the generated keys.

Either way, the collector can also [copy every event into your own database](https://kkkermit.github.io/Shardlens/self-hosting/your-own-database/)
(MongoDB, MySQL, MariaDB, PostgreSQL or SQLite).

## Links

- [On your MongoDB](https://kkkermit.github.io/Shardlens/self-hosting/mongodb/) ·
  [embedded mode](https://kkkermit.github.io/Shardlens/self-hosting/embedded/) ·
  [Docker Compose](https://kkkermit.github.io/Shardlens/self-hosting/docker-compose/) ·
  [upgrading](https://kkkermit.github.io/Shardlens/self-hosting/upgrading/) ·
  [security](https://kkkermit.github.io/Shardlens/operations/security/)
- Using an AI coding agent? Point it at [`llms.txt`](https://kkkermit.github.io/Shardlens/llms.txt), the docs as plain
  text.
- [Source and issues](https://github.com/Kkkermit/Shardlens) · MIT licence · not affiliated with Discord
