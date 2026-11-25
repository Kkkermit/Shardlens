import { TOKENS } from '../../core/tokens.js';
import { REPOSITORIES } from '../../database/index.js';
import type { BotModule } from '../../framework/module.js';
import { pollCommand } from './commands/poll.command.js';
import { voteComponent } from './components/vote.component.js';
import { POLLS, PollService } from './poll.service.js';

export const pollsModule: BotModule = {
  name: 'polls',
  register(container) {
    container.register(
      POLLS.Service,
      (c) => new PollService(c.resolve(REPOSITORIES.Polls), c.resolve(REPOSITORIES.Votes), c.resolve(TOKENS.EventBus)),
    );
  },
  setup({ container, commands, components, bus, logger }) {
    const polls = container.resolve(POLLS.Service);
    commands.add(pollCommand(polls));
    components.add(voteComponent(polls));
    bus.on('poll.created', ({ pollId, guildId }) => logger.debug(`Poll ${pollId} created in guild ${guildId}`));
  },
};
