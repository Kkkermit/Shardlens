import type { VoteChoice } from '../../core/event-bus.js';
import { BaseRepository } from '../base.repository.js';

export interface VoteDocument {
  /** Votes are keyed by the poll message, so a vote can land before the poll document knows its message. */
  messageId: string;
  guildId: string | null;
  userId: string;
  choice: VoteChoice;
  votedAt: Date;
}

export type Tally = Record<VoteChoice, number>;

export class VoteRepository extends BaseRepository<VoteDocument> {
  protected readonly collectionName = 'poll_votes';

  override async ensureIndexes(): Promise<void> {
    await this.collection.createIndexes([
      { key: { messageId: 1, userId: 1 }, unique: true },
      { key: { guildId: 1, userId: 1 } },
    ]);
  }

  /** One vote per person per poll; voting again changes it. */
  async upsert(vote: VoteDocument): Promise<{ created: boolean }> {
    const { messageId, userId, ...rest } = vote;
    const result = await this.collection.updateOne({ messageId, userId }, { $set: rest }, { upsert: true });
    return { created: result.upsertedCount === 1 };
  }

  async tally(messageId: string): Promise<Tally> {
    const rows = await this.collection
      .aggregate<{ _id: VoteChoice; count: number }>([
        { $match: { messageId } },
        { $group: { _id: '$choice', count: { $sum: 1 } } },
      ])
      .toArray();
    const tally: Tally = { yes: 0, no: 0 };
    for (const row of rows) tally[row._id] = row.count;
    return tally;
  }

  countByGuild(guildId: string): Promise<number> {
    return this.collection.countDocuments({ guildId });
  }

  countByUser(guildId: string, userId: string): Promise<number> {
    return this.collection.countDocuments({ guildId, userId });
  }
}
