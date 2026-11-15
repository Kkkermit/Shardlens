import { type Collection, MongoClient } from 'mongodb';
import type { EventSink, StoredEvent } from '../sink.js';

interface Doc {
  _id: string;
  ts: Date;
  appId: string;
  env: string;
  release: string | null;
  type: string;
  guild: string | null;
  userHash: string | null;
  saltPeriod: string | null;
  [field: string]: unknown;
}

/** Duplicate key: the event is already stored (a retried batch). */
const DUPLICATE = 11000;

/**
 * MongoDB and MongoDB Atlas. One document per event, with the event's own fields at the top level, `_id` set to the
 * event ID (so retries are no-ops) and `ts` as a date.
 */
export class MongoSink implements EventSink {
  readonly name = 'mongodb';
  readonly #client: MongoClient;
  readonly #database: string;
  readonly #table: string;
  #collection: Collection<Doc> | undefined;

  constructor(url: string, table: string) {
    this.#client = new MongoClient(url, { serverSelectionTimeoutMS: 10_000, appName: 'shardlens-collector' });
    // The database named in the URL (`mongodb://host/mydb`), or `shardlens`. Parsed by hand: a URL with several hosts
    // (`mongodb://a:27017,b:27017/mydb`) is not a WHATWG URL.
    const named = /^mongodb(?:\+srv)?:\/\/[^/?]*\/([^?]*)/i.exec(url)?.[1];
    this.#database = named ? decodeURIComponent(named) : 'shardlens';
    this.#table = table;
  }

  async init(): Promise<void> {
    await this.#client.connect();
    const collection = this.#client.db(this.#database).collection<Doc>(this.#table);
    await collection.createIndexes([
      { key: { appId: 1, ts: 1 } },
      { key: { type: 1, ts: 1 } },
      { key: { userHash: 1 }, sparse: true },
    ]);
    this.#collection = collection;
  }

  async write(events: readonly StoredEvent[]): Promise<void> {
    const collection = this.#ready();
    if (events.length === 0) return;
    const docs: Doc[] = events.map((e) => ({
      ...e.data,
      _id: e.id,
      ts: e.ts,
      appId: e.appId,
      env: e.env,
      release: e.release,
      type: e.type,
      guild: e.guildId,
      userHash: e.userHash,
      saltPeriod: e.saltPeriod,
    }));
    try {
      await collection.insertMany(docs, { ordered: false });
    } catch (error) {
      const failures = (error as { writeErrors?: unknown }).writeErrors;
      const list = Array.isArray(failures) ? failures : failures ? [failures] : [];
      const onlyDuplicates =
        list.length > 0
          ? list.every((f) => (f as { code?: unknown }).code === DUPLICATE)
          : (error as { code?: unknown }).code === DUPLICATE;
      if (!onlyDuplicates) throw error;
    }
  }

  async erase(appId: string, userHashes: readonly string[]): Promise<number> {
    const res = await this.#ready().deleteMany({ appId, userHash: { $in: [...userHashes] } });
    return res.deletedCount;
  }

  async expire(before: Date): Promise<number> {
    const res = await this.#ready().deleteMany({ ts: { $lt: before } });
    return res.deletedCount;
  }

  async close(): Promise<void> {
    await this.#client.close();
  }

  #ready(): Collection<Doc> {
    if (!this.#collection) throw new Error('MongoDB sink used before init()');
    return this.#collection;
  }
}
