import type { Document } from 'mongodb';
import { type Container, token } from '../core/container.js';
import { TOKENS } from '../core/tokens.js';
import type { BaseRepository } from './base.repository.js';
import { GuildSettingsRepository } from './repositories/guild-settings.repository.js';
import { PollRepository } from './repositories/poll.repository.js';
import { VoteRepository } from './repositories/vote.repository.js';

export const REPOSITORIES = {
  GuildSettings: token<GuildSettingsRepository>('GuildSettingsRepository'),
  Polls: token<PollRepository>('PollRepository'),
  Votes: token<VoteRepository>('VoteRepository'),
} as const;

export function registerRepositories(container: Container): void {
  container
    .register(REPOSITORIES.GuildSettings, (c) => new GuildSettingsRepository(c.resolve(TOKENS.Mongo)))
    .register(REPOSITORIES.Polls, (c) => new PollRepository(c.resolve(TOKENS.Mongo)))
    .register(REPOSITORIES.Votes, (c) => new VoteRepository(c.resolve(TOKENS.Mongo)));
}

export async function ensureIndexes(container: Container): Promise<void> {
  const repositories: Pick<BaseRepository<Document>, 'ensureIndexes'>[] = [
    container.resolve(REPOSITORIES.GuildSettings),
    container.resolve(REPOSITORIES.Polls),
    container.resolve(REPOSITORIES.Votes),
  ];
  await Promise.all(repositories.map((repository) => repository.ensureIndexes()));
}
