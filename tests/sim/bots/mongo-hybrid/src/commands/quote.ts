import { ApplicationCommandType, ContextMenuCommandBuilder } from 'discord.js';
import { Quote } from '../models/Quote';
import type { MessageMenuCommand } from '../types';

const command: MessageMenuCommand = {
  type: 'message',
  data: new ContextMenuCommandBuilder().setName('Quote').setType(ApplicationCommandType.Message),
  async execute(interaction) {
    const message = interaction.targetMessage;
    const guildId = interaction.guildId!;
    const existing = await Quote.findOne({ guildId, messageId: message.id });
    if (existing) {
      await interaction.reply('Quoted. (already in the quote book)');
      return;
    }
    await Quote.create({
      guildId,
      channelId: message.channelId,
      messageId: message.id,
      authorId: message.author.id,
      content: message.content,
      savedBy: interaction.user.id,
    });
    await interaction.reply('Quoted.');
  },
};

export default command;
