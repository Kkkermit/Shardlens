const { Events } = require('discord.js');
const GuildConfig = require('../models/GuildConfig');

module.exports = {
  name: Events.GuildCreate,
  async execute(guild) {
    console.log(`Joined a new server: ${guild.name} (${guild.memberCount} members)`);
    try {
      await GuildConfig.findOneAndUpdate(
        { guildId: guild.id },
        { $setOnInsert: { guildId: guild.id } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
    } catch (err) {
      console.error('Could not create config for new server', err);
    }
  },
};
