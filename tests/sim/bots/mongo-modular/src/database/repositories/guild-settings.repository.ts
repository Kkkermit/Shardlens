import type { WithId } from 'mongodb';
import { BaseRepository } from '../base.repository.js';

/** Documents may have been written by older versions (or by hand), so everything but guildId is optional. */
export interface GuildSettingsDocument {
  guildId: string;
  prefix?: string;
  createdAt?: Date;
  updatedAt?: Date;
  leftAt?: Date | null;
}

export class GuildSettingsRepository extends BaseRepository<GuildSettingsDocument> {
  protected readonly collectionName = 'guild_settings';

  override async ensureIndexes(): Promise<void> {
    await this.collection.createIndex({ guildId: 1 }, { unique: true });
  }

  findByGuildId(guildId: string): Promise<WithId<GuildSettingsDocument> | null> {
    return this.collection.findOne({ guildId });
  }

  async upsertDefaults(guildId: string, defaults: Pick<GuildSettingsDocument, 'prefix'>): Promise<void> {
    await this.collection.updateOne(
      { guildId },
      { $setOnInsert: { ...defaults, createdAt: new Date() }, $set: { leftAt: null } },
      { upsert: true },
    );
  }

  async setPrefix(guildId: string, prefix: string): Promise<void> {
    await this.collection.updateOne(
      { guildId },
      { $set: { prefix, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
      { upsert: true },
    );
  }

  async markLeft(guildId: string): Promise<void> {
    await this.collection.updateOne({ guildId }, { $set: { leftAt: new Date() } });
  }
}
