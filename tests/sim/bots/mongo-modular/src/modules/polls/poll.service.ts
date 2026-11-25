import type { ObjectId } from 'mongodb';
import { token } from '../../core/container.js';
import type { EventBus, VoteChoice } from '../../core/event-bus.js';
import type { PollRepository } from '../../database/repositories/poll.repository.js';
import type { Tally, VoteRepository } from '../../database/repositories/vote.repository.js';

export interface NewPoll {
  guildId: string;
  channelId: string;
  question: string;
  createdBy: string;
}

export interface NewVote {
  messageId: string;
  guildId: string | null;
  userId: string;
  choice: VoteChoice;
}

export class PollService {
  constructor(
    private readonly polls: PollRepository,
    private readonly votes: VoteRepository,
    private readonly bus: EventBus,
  ) {}

  async create(poll: NewPoll): Promise<ObjectId> {
    const id = await this.polls.create({ ...poll, messageId: null, createdAt: new Date() });
    this.bus.emit('poll.created', { pollId: id.toHexString(), guildId: poll.guildId });
    return id;
  }

  attachMessage(pollId: ObjectId, messageId: string): Promise<void> {
    return this.polls.attachMessage(pollId, messageId);
  }

  async vote(vote: NewVote): Promise<Tally> {
    const { created } = await this.votes.upsert({ ...vote, votedAt: new Date() });
    this.bus.emit('poll.voted', { messageId: vote.messageId, guildId: vote.guildId, choice: vote.choice, firstVote: created });
    return this.votes.tally(vote.messageId);
  }
}

export const POLLS = {
  Service: token<PollService>('PollService'),
} as const;
