import { MessageFlags } from 'discord.js';
import { defineContextMenu } from '../../../framework/types.js';
import type { StatsService } from '../stats.service.js';

export const statsCardMenu = (stats: StatsService) =>
  defineContextMenu({
    name: 'Stats',
    description: "A member's poll stats",
    type: 'user',
    guildOnly: true,
    async run(interaction) {
      const card = await stats.memberCard(interaction.guildId!, interaction.targetUser.id);
      await interaction.reply({
        content: `**Stats card for ${interaction.targetUser.displayName}**\nPolls started: ${card.pollsCreated}\nVotes cast: ${card.votesCast}`,
        flags: MessageFlags.Ephemeral,
      });
    },
  });
