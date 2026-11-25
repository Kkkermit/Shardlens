import { SlashCommandBuilder } from 'discord.js';
import type { SlashCommand } from '../types';

const command: SlashCommand = {
  type: 'slash',
  data: new SlashCommandBuilder().setName('ping').setDescription('Replies with Pong!'),
  async execute(interaction) {
    await interaction.reply(`Pong! Cluster ${interaction.client.cluster.id}, ${interaction.client.ws.ping}ms`);
  },
};

export default command;
