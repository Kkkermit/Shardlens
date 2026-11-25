import type { ObjectId, WithId } from 'mongodb';
import { BaseRepository } from '../base.repository.js';

export interface PollDocument {
  guildId: string;
  channelId: string;
  /** Set once the poll message has been sent. */
  messageId: string | null;
  question: string;
  createdBy: string;
  createdAt: Date;
}

export class PollRepository extends BaseRepository<PollDocument> {
  protected readonly collectionName = 'polls';

  override async ensureIndexes(): Promise<void> {
    await this.collection.createIndexes([
      { key: { guildId: 1, createdAt: -1 } },
      { key: { messageId: 1 } },
      { key: { guildId: 1, createdBy: 1 } },
    ]);
  }

  async create(poll: PollDocument): Promise<ObjectId> {
    const { insertedId } = await this.collection.insertOne(poll);
    return insertedId;
  }

  async attachMessage(id: ObjectId, messageId: string): Promise<void> {
    await this.collection.updateOne({ _id: id }, { $set: { messageId } });
  }

  findByMessageId(messageId: string): Promise<WithId<PollDocument> | null> {
    return this.collection.findOne({ messageId });
  }

  recentByGuild(guildId: string, limit = 5): Promise<WithId<PollDocument>[]> {
    return this.collection.find({ guildId }).sort({ createdAt: -1 }).limit(limit).toArray();
  }

  countByGuild(guildId: string): Promise<number> {
    return this.collection.countDocuments({ guildId });
  }

  countByAuthor(guildId: string, userId: string): Promise<number> {
    return this.collection.countDocuments({ guildId, createdBy: userId });
  }
}
