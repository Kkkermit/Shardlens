const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder().setName('broken').setDescription('Always fails'),
  async execute() {
    throw new TypeError('This command is broken on purpose');
  },
};
