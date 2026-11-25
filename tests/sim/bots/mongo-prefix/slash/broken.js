const { SlashCommandBuilder } = require('discord.js');

// used this to test the error handler, TODO remove before next release
module.exports = {
  data: new SlashCommandBuilder().setName('broken').setDescription('test command, ignore'),
  async execute() {
    throw new Error('broken command was run');
  },
};
