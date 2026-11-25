import { InteractionContextType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { defineCommand } from '../../../framework/types.js';
import { voteButtons } from '../components/vote.component.js';
import type { PollService } from '../poll.service.js';

export const pollCommand = (polls: PollService) =>
  defineCommand({
    name: 'poll',
    description: 'Start a yes/no poll',
    category: 'polls',
    guildOnly: true,
    cooldown: 30,
    botPermissions: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks],
    slash: {
      data: new SlashCommandBuilder()
        .setName('poll')
        .setDescription('Start a yes/no poll')
        .setContexts(InteractionContextType.Guild)
        .addStringOption((option) =>
          option.setName('question').setDescription('What should people vote on?').setRequired(true).setMaxLength(200),
        ),
      async run(interaction) {
        const question = interaction.options.getString('question', true);
        const pollId = await polls.create({
          guildId: interaction.guildId!,
          channelId: interaction.channelId,
          question,
          createdBy: interaction.user.id,
        });

        const response = await interaction.reply({
          content: `📊 **${question}**`,
          components: [voteButtons()],
          withResponse: true,
        });
        const messageId = response.resource?.message?.id;
        if (messageId) await polls.attachMessage(pollId, messageId);
      },
    },
  });
