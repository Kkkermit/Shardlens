import { ApplicationCommandType, ContextMenuCommandBuilder, MessageFlags } from 'discord.js';
import { Feedback } from '../models/Feedback';
import { Ticket } from '../models/Ticket';
import type { UserMenuCommand } from '../types';

const command: UserMenuCommand = {
  type: 'user',
  data: new ContextMenuCommandBuilder().setName('Profile').setType(ApplicationCommandType.User),
  async execute(interaction) {
    const target = interaction.targetUser;
    const [tickets, open, feedback] = await Promise.all([
      Ticket.countDocuments({ guildId: interaction.guildId, userId: target.id }),
      Ticket.countDocuments({ guildId: interaction.guildId, userId: target.id, status: 'open' }),
      Feedback.countDocuments({ userId: target.id }),
    ]);
    await interaction.reply({
      content: `**Profile card**\nTickets: ${tickets} (${open} open)\nFeedback sent: ${feedback}`,
      flags: MessageFlags.Ephemeral,
    });
  },
};

export default command;
