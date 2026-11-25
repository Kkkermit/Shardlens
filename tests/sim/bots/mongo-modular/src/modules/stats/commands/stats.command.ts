import { defineCommand } from '../../../framework/types.js';
import type { StatsService } from '../stats.service.js';

export const statsCommand = (stats: StatsService) =>
  defineCommand({
    name: 'stats',
    description: 'Poll stats for this server',
    category: 'stats',
    aliases: ['st'],
    guildOnly: true,
    prefix: {
      async run(message) {
        const summary = await stats.guildSummary(message.guildId!);
        return message.reply(
          [
            `**${message.guild?.name}**`,
            `Polls: ${summary.pollCount} · Votes: ${summary.voteCount}`,
            `Latest poll: "${summary.latestQuestion}" (<t:${Math.floor(summary.latestAt.getTime() / 1000)}:R>)`,
          ].join('\n'),
        );
      },
    },
  });
