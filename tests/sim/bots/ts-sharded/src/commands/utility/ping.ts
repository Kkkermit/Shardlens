import { type ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';

export default {
  data: new SlashCommandBuilder().setName('ping').setDescription('Replies with Pong!'),
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.reply(`Pong from shard ${interaction.client.shard?.ids[0]}!`);
  },
};
