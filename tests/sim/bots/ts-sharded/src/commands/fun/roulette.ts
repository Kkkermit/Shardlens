import { type ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';

export default {
  data: new SlashCommandBuilder().setName('roulette').setDescription('Feeling lucky?'),
  async execute(_interaction: ChatInputCommandInteraction) {
    throw new TypeError('The wheel fell off');
  },
};
