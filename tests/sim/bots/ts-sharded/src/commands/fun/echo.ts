import { type ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';

export default {
  data: new SlashCommandBuilder()
    .setName('echo')
    .setDescription('Replies with your input!')
    .addStringOption((option) => option.setName('input').setDescription('The input to echo back').setRequired(true)),
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.reply({ content: interaction.options.getString('input', true), allowedMentions: { parse: [] } });
  },
};
