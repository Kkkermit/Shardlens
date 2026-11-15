import { ApplicationCommandType, ContextMenuCommandBuilder } from 'discord.js';
import type { MenuCommand } from '../types.js';

export default {
  data: new ContextMenuCommandBuilder().setName('Quote').setType(ApplicationCommandType.Message),
  async execute(interaction) {
    await interaction.reply('Quoted.');
  },
} satisfies MenuCommand;
