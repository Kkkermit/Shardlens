import { setTimeout as sleep } from 'node:timers/promises';
import { SlashCommandBuilder } from 'discord.js';
import type { SlashCommand } from '../types.js';

export default {
  data: new SlashCommandBuilder()
    .setName('report')
    .setDescription('Build a usage report (slow)')
    .addBooleanOption((o) => o.setName('detailed').setDescription('Include everything')),
  async execute(interaction) {
    if (interaction.options.getBoolean('detailed')) {
      // The detailed report forgets to defer, so it misses Discord's 3-second deadline.
      await sleep(3_500);
      await interaction.reply('Detailed report ready.');
      return;
    }
    await interaction.deferReply();
    await sleep(1_000);
    await interaction.editReply('Report ready.');
  },
} satisfies SlashCommand;
