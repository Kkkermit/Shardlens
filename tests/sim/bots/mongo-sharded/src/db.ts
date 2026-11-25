import { type Db, MongoClient } from 'mongodb';

// Every shard is its own process, so each one gets its own client (and pool).
const url = process.env.MONGODB_URL;
if (!url) throw new Error('MONGODB_URL is missing from .env');

const mongo = new MongoClient(url, { maxPoolSize: 5, appName: `shardbot-shard-${process.env.SHARDS ?? '0'}` });
let db: Db | undefined;

export interface EchoCount {
  guildId: string;
  count: number;
  lastEchoAt: Date;
}

export interface ServerInfo {
  guildId: string;
  name: string;
  memberCount: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  leftAt?: Date;
}

export interface Spin {
  guildId: string;
  userId: string;
  bet: number;
  color: 'red' | 'black';
  landed: 'red' | 'black';
  won: boolean;
  at: Date;
}

export async function connectDb() {
  await mongo.connect();
  db = mongo.db();
  await db.collection('echo_counts').createIndex({ guildId: 1 }, { unique: true });
  await db.collection('spins').createIndex({ guildId: 1, userId: 1 });
  await db.collection('servers').createIndex({ guildId: 1 }, { unique: true });
}

function database() {
  if (!db) throw new Error('db not connected yet');
  return db;
}

export const echoCounts = () => database().collection<EchoCount>('echo_counts');
export const spins = () => database().collection<Spin>('spins');
export const servers = () => database().collection<ServerInfo>('servers');

/** Round trip to the database in ms, for /ping. */
export async function dbLatency() {
  const started = performance.now();
  await database().command({ ping: 1 });
  return Math.round(performance.now() - started);
}

export async function closeDb() {
  await mongo.close();
}
