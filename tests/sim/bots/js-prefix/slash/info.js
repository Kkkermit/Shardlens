const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder().setName('info').setDescription('About this bot'),
  async execute(interaction) {
    await interaction.reply(`Serving ${interaction.client.guilds.cache.size} servers.`);
  },
};
