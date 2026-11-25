import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { defineComponent } from '../../../framework/types.js';
import type { PollService } from '../poll.service.js';

export function voteButtons(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('poll:yes').setLabel('Yes').setEmoji('👍').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('poll:no').setLabel('No').setEmoji('👎').setStyle(ButtonStyle.Danger),
  );
}

export const voteComponent = (polls: PollService) =>
  defineComponent({
    id: 'poll',
    async run(interaction) {
      if (!interaction.isButton()) return;
      const choice = interaction.customId.split(':')[1];
      if (choice !== 'yes' && choice !== 'no') return;

      const tally = await polls.vote({
        messageId: interaction.message.id,
        guildId: interaction.guildId,
        userId: interaction.user.id,
        choice,
      });
      await interaction.reply({ content: `Vote counted. 👍 ${tally.yes} · 👎 ${tally.no}`, flags: MessageFlags.Ephemeral });
    },
  });
