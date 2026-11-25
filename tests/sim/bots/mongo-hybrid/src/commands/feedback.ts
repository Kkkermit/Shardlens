import { ActionRowBuilder, ModalBuilder, SlashCommandBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import type { SlashCommand } from '../types';

const command: SlashCommand = {
  type: 'slash',
  data: new SlashCommandBuilder().setName('feedback').setDescription('Tell us what you think of the bot'),
  async execute(interaction) {
    const modal = new ModalBuilder()
      .setCustomId('feedback:form')
      .setTitle('Feedback')
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('text')
            .setLabel('Your feedback')
            .setStyle(TextInputStyle.Paragraph)
            .setMaxLength(4000)
            .setRequired(true),
        ),
      );
    await interaction.showModal(modal);
  },
};

export default command;
