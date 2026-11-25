import { SlashCommandBuilder } from 'discord.js';
import { echoCounts } from '../db.js';
import type { Command } from './index.js';

export default {
  data: new SlashCommandBuilder()
    .setName('echo')
    .setDescription('Repeats what you say')
    .addStringOption((option) => option.setName('input').setDescription('What to repeat').setRequired(true)),
  async run(interaction) {
    const input = interaction.options.getString('input', true);
    await interaction.reply({ content: input, allowedMentions: { parse: [] } });

    await echoCounts().updateOne(
      { guildId: interaction.guildId ?? 'dm' },
      { $inc: { count: 1 }, $set: { lastEchoAt: new Date() } },
      { upsert: true },
    );
  },
} satisfies Command;
