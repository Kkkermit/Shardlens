import type { Collection, Document } from 'mongodb';
import type { MongoConnection } from './mongo.js';

export abstract class BaseRepository<T extends Document> {
  protected abstract readonly collectionName: string;

  constructor(protected readonly mongo: MongoConnection) {}

  protected get collection(): Collection<T> {
    return this.mongo.collection<T>(this.collectionName);
  }

  /** Runs once at startup. Override to create the indexes the queries rely on. */
  async ensureIndexes(): Promise<void> {}
}
