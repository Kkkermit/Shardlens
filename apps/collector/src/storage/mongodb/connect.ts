import { type Db, MongoClient } from 'mongodb';
import { type Collections, collections } from './collections.js';

/** A connected client, its database and the collections MongoStore keeps there. */
export interface Mongo {
  client: MongoClient;
  db: Db;
  c: Collections;
}

/** A MongoDB connection string, as opposed to PostgreSQL's. */
export const MONGODB_URL = /^mongodb(?:\+srv)?:\/\//i;

/**
 * The database a `mongodb://` or `mongodb+srv://` URL names (`mongodb://host/mydb`), or `shardlens`. Parsed by hand:
 * a URL with several hosts (`mongodb://a:27017,b:27017/mydb`) is not a WHATWG URL.
 */
export function databaseName(url: string): string {
  const named = /^mongodb(?:\+srv)?:\/\/[^/?]*\/([^?]*)/i.exec(url)?.[1];
  return named ? decodeURIComponent(named) : 'shardlens';
}

/** Connects, failing within 10 seconds when no server answers. The caller closes `client`. */
export async function openMongo(url: string, appName = 'shardlens-collector'): Promise<Mongo> {
  const client = new MongoClient(url, { serverSelectionTimeoutMS: 10_000, appName });
  await client.connect();
  const db = client.db(databaseName(url));
  return { client, db, c: collections(db) };
}
