import { SlashCommandBuilder } from 'discord.js';
import type { SlashCommand } from '../types';

// for checking that errors get caught and logged properly
const command: SlashCommand = {
  type: 'slash',
  data: new SlashCommandBuilder().setName('crash').setDescription('Throws an error (debug)'),
  async execute() {
    throw new RangeError('Crash command used');
  },
};

export default command;
