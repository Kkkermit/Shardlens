const { Events } = require('discord.js');
const GuildConfig = require('../models/GuildConfig');
const Warning = require('../models/Warning');
const { forget } = require('../util/prefixes');

module.exports = {
  name: Events.GuildDelete,
  async execute(guild) {
    console.log(`Removed from server ${guild.id}, cleaning up`);
    forget(guild.id);
    try {
      await GuildConfig.deleteOne({ guildId: guild.id });
      await Warning.deleteMany({ guildId: guild.id });
    } catch (err) {
      console.error('Cleanup failed', err);
    }
  },
};
