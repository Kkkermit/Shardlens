import { type Collection, type Db, type Document, MongoClient } from 'mongodb';
import type { AppConfig } from '../core/config.js';
import type { Logger } from '../core/logger.js';

/** The one MongoClient for the whole process; repositories borrow collections from it. */
export class MongoConnection {
  private readonly client: MongoClient;
  private db: Db | undefined;

  constructor(
    private readonly config: AppConfig['mongo'],
    private readonly logger: Logger,
  ) {
    this.client = new MongoClient(config.uri, {
      appName: config.appName,
      maxPoolSize: config.maxPoolSize,
      serverSelectionTimeoutMS: 10_000,
    });
  }

  async connect(): Promise<void> {
    await this.client.connect();
    this.db = this.client.db(this.config.dbName);
    await this.db.command({ ping: 1 });
    this.logger.info(`Connected to MongoDB, database "${this.db.databaseName}"`);
  }

  get database(): Db {
    if (!this.db) throw new Error('MongoConnection.connect() has not been called yet');
    return this.db;
  }

  collection<T extends Document>(name: string): Collection<T> {
    return this.database.collection<T>(name);
  }

  async close(): Promise<void> {
    await this.client.close();
    this.logger.info('MongoDB connection closed');
  }
}
