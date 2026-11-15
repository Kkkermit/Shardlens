import { ActionRowBuilder, ModalBuilder, SlashCommandBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import type { SlashCommand } from '../types.js';

export default {
  data: new SlashCommandBuilder().setName('feedback').setDescription('Send feedback'),
  async execute(interaction) {
    const modal = new ModalBuilder()
      .setCustomId('feedback:form')
      .setTitle('Feedback')
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId('text').setLabel('Your feedback').setStyle(TextInputStyle.Paragraph),
        ),
      );
    await interaction.showModal(modal);
  },
} satisfies SlashCommand;
