import { SlashCommandBuilder } from 'discord.js';
import { defineCommand } from '../../../framework/types.js';

export const pingCommand = defineCommand({
  name: 'ping',
  description: 'Check that the bot is alive',
  category: 'core',
  aliases: ['pong'],
  slash: {
    data: new SlashCommandBuilder().setName('ping').setDescription('Check that the bot is alive'),
    async run(interaction) {
      await interaction.reply(`🏓 Pong! Shard ${interaction.guild?.shardId ?? 0}, heartbeat ${interaction.client.ws.ping}ms`);
    },
  },
  prefix: {
    async run(message) {
      await message.reply(`🏓 Pong! Shard ${message.guild?.shardId ?? 0}, heartbeat ${message.client.ws.ping}ms`);
    },
  },
});
