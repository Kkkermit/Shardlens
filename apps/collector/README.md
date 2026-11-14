# @shardlens/collector

The [Shardlens](https://github.com/Kkkermit/Shardlens) collector: ingest, rollups, the query API, live updates and the
dashboard. Shardlens is self-hosted, privacy-first analytics and health monitoring for discord.js bots.

Most people run the collector as a container next to PostgreSQL. See the
[quick start](https://kkkermit.github.io/Shardlens/getting-started/quick-start/): `npx shardlens init`, then
`docker compose up -d`.

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
```

Keep the data folder private and out of version control: it holds the database and the generated keys.

## Links

- [Embedded mode](https://kkkermit.github.io/Shardlens/self-hosting/embedded/) ·
  [Docker Compose](https://kkkermit.github.io/Shardlens/self-hosting/docker-compose/) ·
  [security](https://kkkermit.github.io/Shardlens/operations/security/)
- Using an AI coding agent? Point it at [`llms.txt`](https://kkkermit.github.io/Shardlens/llms.txt), the docs as plain
  text.
- [Source and issues](https://github.com/Kkkermit/Shardlens) · MIT licence · not affiliated with Discord
