import { setTimeout as sleep } from 'node:timers/promises';
import { SlashCommandBuilder } from 'discord.js';
import { Feedback } from '../models/Feedback';
import { Ticket } from '../models/Ticket';
import type { SlashCommand } from '../types';

const DAY = 24 * 60 * 60 * 1000;

async function summary(guildId: string) {
  const [open, closed, feedback] = await Promise.all([
    Ticket.countDocuments({ guildId, status: 'open' }),
    Ticket.countDocuments({ guildId, status: 'closed' }),
    Feedback.countDocuments({ guildId }),
  ]);
  return `Open tickets: ${open}\nClosed tickets: ${closed}\nFeedback received: ${feedback}`;
}

const command: SlashCommand = {
  type: 'slash',
  data: new SlashCommandBuilder()
    .setName('report')
    .setDescription('Weekly support report')
    .setDMPermission(false)
    .addBooleanOption((o) => o.setName('detailed').setDescription('Include a per-day breakdown')),
  async execute(interaction) {
    const guildId = interaction.guildId!;

    if (interaction.options.getBoolean('detailed')) {
      const lines: string[] = [];
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      for (let i = 6; i >= 0; i--) {
        const from = new Date(today.getTime() - i * DAY);
        const to = new Date(from.getTime() + DAY);
        const opened = await Ticket.countDocuments({ guildId, createdAt: { $gte: from, $lt: to } });
        lines.push(`${from.toISOString().slice(0, 10)}: ${opened} opened`);
        // atlas free tier kept rate limiting us when this ran in a tight loop
        await sleep(500);
      }
      await interaction.reply(`**Support report (detailed)**\n${await summary(guildId)}\n\n${lines.join('\n')}`);
      return;
    }

    await interaction.deferReply();
    await interaction.editReply(`**Support report**\n${await summary(guildId)}`);
  },
};

export default command;
