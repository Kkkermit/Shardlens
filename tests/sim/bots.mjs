// How the sim runs each fixture in bots/: its entry point, the collector it reports to, where that collector keeps its
// data and where the install copies events. The bots' code is used as the coding agents left it.
import { mongoDatabaseUrl, mongosh } from './databases.mjs';

// Each run uses ports 1 to 14 after SIM_PORTS (fake Discords on 1–4 and 11–14, the databases on 7–9) and 1 to 24
// after SIM_COLLECTOR_PORTS (collectors on 1–4 and 11–14, `shardlens dashboard` on 21–24).
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
  // The bots below keep their data in their own MongoDB, and Shardlens with it: no collector process. The collector image
  // on the same database reads the numbers (`collectorPort`), and so does `shardlens dashboard` (`dashboardPort`).
  'mongo-prefix': {
    main: 'index.js',
    discordPort: base + 11,
    collectorPort: collectorBase + 11,
    dashboardPort: collectorBase + 21,
    mongodb: { env: 'MONGO_URI', database: 'modbot' },
    databases: ['mongo'],
  },
  // ShardingManager with two shards, each its own process and its own collector on the same database.
  'mongo-sharded': {
    main: 'dist/index.js',
    discordPort: base + 12,
    collectorPort: collectorBase + 12,
    dashboardPort: collectorBase + 22,
    shards: 2,
    mongodb: { env: 'MONGODB_URL', database: 'shardbot' },
    databases: ['mongo'],
  },
  // discord-hybrid-sharding: two clusters of one shard. The scenario's outage is MongoDB's.
  'mongo-hybrid': {
    main: 'dist/index.js',
    discordPort: base + 13,
    collectorPort: collectorBase + 13,
    dashboardPort: collectorBase + 23,
    shards: 2,
    mongodb: { env: 'DATABASE_URL', database: 'helpdesk' },
    databases: ['mongo'],
  },
  // A hand-rolled modular codebase with internal sharding (`shards: 'auto'`).
  'mongo-modular': {
    main: 'dist/index.js',
    discordPort: base + 14,
    collectorPort: collectorBase + 14,
    dashboardPort: collectorBase + 24,
    shards: 2,
    mongodb: { env: 'MONGO_CONNECTION_STRING', database: 'nexus' },
    databases: ['mongo'],
    // As for sapphire: server 2 set its prefix to ">" before the bot started.
    prepare: ({ guilds }) =>
      mongosh('nexus', `db.guild_settings.insertOne({ guildId: '${guilds[1].id}', prefix: '>' })`),
  },
  sapphire: {
    main: 'dist/index.js',
    discordPort: base + 3,
    collectorPort: collectorBase + 3,
    embedded: { dir: 'shardlens-data', port: 8093 },
    // The bot's own database, which also holds its per-server prefixes.
    copy: { mongo: 'sapphire-bot' },
    databases: ['mongo'],
    env: ({ databases }) => ({ MONGODB_URI: mongoDatabaseUrl(databases.mongo, 'sapphire-bot') }),
    // The scenario expects server 2 to have set its prefix to ">" before the bot started.
    prepare: ({ guilds }) =>
      mongosh('sapphire-bot', `db.guildsettings.insertOne({ guildId: '${guilds[1].id}', prefix: '>' })`),
  },
};
