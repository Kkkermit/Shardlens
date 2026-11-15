import { SlashCommandBuilder } from 'discord.js';
import type { SlashCommand } from '../types.js';

export default {
  data: new SlashCommandBuilder().setName('crash').setDescription('Throws an error'),
  async execute() {
    throw new RangeError('Something went out of range');
  },
} satisfies SlashCommand;
