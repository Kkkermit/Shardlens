const { SlashCommandBuilder } = require('discord.js');
const Warning = require('../models/Warning');

module.exports = {
  data: new SlashCommandBuilder().setName('info').setDescription('Info about the bot'),
  async execute(interaction, client) {
    const warnings = await Warning.estimatedDocumentCount();
    await interaction.reply(
      `Serving ${client.guilds.cache.size} servers. ${warnings} warnings handed out so far. Uptime: ${Math.floor(process.uptime() / 60)} min`,
    );
  },
};
