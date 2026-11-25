import { token } from '../../core/container.js';
import type { PollRepository } from '../../database/repositories/poll.repository.js';
import type { VoteRepository } from '../../database/repositories/vote.repository.js';

export interface GuildSummary {
  pollCount: number;
  voteCount: number;
  latestQuestion: string;
  latestAt: Date;
}

export interface MemberCard {
  pollsCreated: number;
  votesCast: number;
}

export class StatsService {
  constructor(
    private readonly polls: PollRepository,
    private readonly votes: VoteRepository,
  ) {}

  async guildSummary(guildId: string): Promise<GuildSummary> {
    const [pollCount, voteCount, [latest]] = await Promise.all([
      this.polls.countByGuild(guildId),
      this.votes.countByGuild(guildId),
      this.polls.recentByGuild(guildId, 1),
    ]);
    return { pollCount, voteCount, latestQuestion: latest.question, latestAt: latest.createdAt };
  }

  async memberCard(guildId: string, userId: string): Promise<MemberCard> {
    const [pollsCreated, votesCast] = await Promise.all([
      this.polls.countByAuthor(guildId, userId),
      this.votes.countByUser(guildId, userId),
    ]);
    return { pollsCreated, votesCast };
  }
}

export const STATS = {
  Service: token<StatsService>('StatsService'),
} as const;
