import { type EventSink, type StoredEvent, startEmbeddedCollector } from '@shardlens/collector/embedded';

// Embedded mode, with every event also copied into the MongoDB the bot already uses. A `mysql://`, `mariadb://`,
// `postgres://` or `sqlite:./events.db` URL works the same way.
const collector = await startEmbeddedCollector({
  dataDir: './shardlens-data',
  appId: process.env.DISCORD_APP_ID!,
  sink: { to: process.env.MONGODB_URI!, retentionDays: 90 },
});

// Or send copies anywhere, by writing a sink yourself. Writes must ignore an event ID they already hold.
declare const myStore: {
  upsertMany(rows: StoredEvent[]): Promise<void>;
  deleteWhere(filter: { appId: string; userHashes: readonly string[] } | { before: Date }): Promise<number>;
};

const custom: EventSink = {
  name: 'my-store',
  write: (events) => myStore.upsertMany([...events]),
  erase: (appId, userHashes) => myStore.deleteWhere({ appId, userHashes }),
  expire: (before) => myStore.deleteWhere({ before }),
  close: async () => undefined,
};

const other = await startEmbeddedCollector({
  dataDir: './shardlens-other',
  appId: process.env.DISCORD_APP_ID!,
  port: 8081,
  sink: { to: custom, events: ['interaction', 'message_command', 'custom'] },
});

export { collector, other };
