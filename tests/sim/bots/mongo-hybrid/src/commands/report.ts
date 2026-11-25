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
    .addBooleanOption((o) => o.setName('detailed').setDescription('Include a per-day breakdown and top reporters')),
  async execute(interaction) {
    const guildId = interaction.guildId!;

    if (interaction.options.getBoolean('detailed')) {
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      // one query for the whole week (used to be one per day, atlas free tier didn't like that)
      const [text, week] = await Promise.all([
        summary(guildId),
        Ticket.find({ guildId, createdAt: { $gte: new Date(today.getTime() - 6 * DAY) } }, { userId: 1, createdAt: 1 }).lean(),
      ]);

      const days: string[] = [];
      for (let i = 6; i >= 0; i--) {
        const from = today.getTime() - i * DAY;
        const opened = week.filter((t) => t.createdAt.getTime() >= from && t.createdAt.getTime() < from + DAY).length;
        days.push(`${new Date(from).toISOString().slice(0, 10)}: ${opened} opened`);
      }

      const perUser = new Map<string, number>();
      for (const t of week) perUser.set(t.userId, (perUser.get(t.userId) ?? 0) + 1);
      const reporters: string[] = [];
      for (const [userId, count] of [...perUser].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
        const user = await interaction.client.users.fetch(userId).catch(() => null);
        reporters.push(`${user?.displayName ?? 'Unknown user'}: ${count}`);
        // got a 429 once fetching users back to back
        await sleep(750);
      }

      await interaction.reply(
        `**Support report (detailed)**\n${text}\n\n${days.join('\n')}\n\n**Top reporters**\n${reporters.join('\n') || 'nobody yet'}`,
      );
      return;
    }

    await interaction.deferReply();
    await interaction.editReply(`**Support report**\n${await summary(guildId)}`);
  },
};

export default command;
