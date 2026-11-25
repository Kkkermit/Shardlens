import { REPOSITORIES } from '../../database/index.js';
import type { BotModule } from '../../framework/module.js';
import { statsCommand } from './commands/stats.command.js';
import { statsCardMenu } from './commands/stats-card.command.js';
import { STATS, StatsService } from './stats.service.js';

export const statsModule: BotModule = {
  name: 'stats',
  register(container) {
    container.register(STATS.Service, (c) => new StatsService(c.resolve(REPOSITORIES.Polls), c.resolve(REPOSITORIES.Votes)));
  },
  setup({ container, commands }) {
    const stats = container.resolve(STATS.Service);
    commands.add(statsCommand(stats)).addContextMenu(statsCardMenu(stats));
  },
};
