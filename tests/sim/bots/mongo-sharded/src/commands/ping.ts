import { SlashCommandBuilder } from 'discord.js';
import { dbLatency } from '../db.js';
import type { Command } from './index.js';

export default {
  data: new SlashCommandBuilder().setName('ping').setDescription('Replies with Pong!'),
  async run(interaction) {
    const db = await dbLatency();
    await interaction.reply(
      `Pong from shard ${interaction.client.shard?.ids[0] ?? 0}! (gateway ${interaction.client.ws.ping}ms, db ${db}ms)`,
    );
  },
} satisfies Command;
