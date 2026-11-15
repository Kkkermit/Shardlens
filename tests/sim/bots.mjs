// How the sim runs each fixture in bots/: its entry point, the collector it reports to, where that collector keeps its
// data and where the install copies events. The bots' code is used as the coding agents left it.
import { mongosh } from './databases.mjs';

// Each run uses the nine ports after these: SIM_PORTS for the fake Discords and the databases, SIM_COLLECTOR_PORTS
// for the collectors.
const base = Number(process.env.SIM_PORTS ?? 9600);
const collectorBase = Number(process.env.SIM_COLLECTOR_PORTS ?? 8600);

export const DATABASE_PORTS = { postgres: base + 7, mysql: base + 8, mongo: base + 9 };

export const BOTS = {
  'js-prefix': {
    main: 'index.js',
    discordPort: base + 1,
    collectorPort: collectorBase + 1,
    // Embedded collector: its data folder, and the port the bot's code gives it.
    embedded: { dir: 'data/shardlens', port: 8091 },
    copy: { sqlite: 'data/shardlens-events.db' },
    databases: [],
  },
  'ts-guide': {
    main: 'dist/index.js',
    discordPort: base + 2,
    collectorPort: collectorBase + 2,
    // A standalone collector on PostgreSQL, copying events to MySQL. The bot reads its URL and key from the env.
    copy: { mysql: 'shardlens' },
    databases: ['postgres', 'mysql'],
    env: ({ collector }) => ({ SHARDLENS_URL: collector.url, SHARDLENS_INGEST_KEY: collector.ingestKey }),
  },
  // ShardingManager with two shards, each its own process, on the same standalone collector as ts-guide.
  'ts-sharded': {
    main: 'dist/index.js',
    discordPort: base + 4,
    collectorPort: collectorBase + 4,
    shards: 2,
    copy: { mysql: 'shardlens' },
    databases: ['postgres', 'mysql'],
    env: ({ collector }) => ({ SHARDLENS_URL: collector.url, SHARDLENS_INGEST_KEY: collector.ingestKey }),
  },
  sapphire: {
    main: 'dist/index.js',
    discordPort: base + 3,
    collectorPort: collectorBase + 3,
    embedded: { dir: 'shardlens-data', port: 8093 },
    // The bot's own database, which also holds its per-server prefixes.
    copy: { mongo: 'sapphire-bot' },
    databases: ['mongo'],
    env: ({ databases }) => ({ MONGODB_URI: `${databases.mongo}/sapphire-bot` }),
    // The scenario expects server 2 to have set its prefix to ">" before the bot started.
    prepare: ({ guilds }) =>
      mongosh('sapphire-bot', `db.guildsettings.insertOne({ guildId: '${guilds[1].id}', prefix: '>' })`),
  },
};
