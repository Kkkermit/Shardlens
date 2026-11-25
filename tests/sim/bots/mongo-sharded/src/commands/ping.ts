import { SlashCommandBuilder } from 'discord.js';
import type { Command } from './index.js';

export default {
  data: new SlashCommandBuilder().setName('ping').setDescription('Replies with Pong!'),
  async run(interaction) {
    await interaction.reply(`Pong from shard ${interaction.client.shard?.ids[0] ?? 0}! (${interaction.client.ws.ping}ms)`);
  },
} satisfies Command;
