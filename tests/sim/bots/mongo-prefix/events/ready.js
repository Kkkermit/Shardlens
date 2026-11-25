const { ActivityType, Events } = require('discord.js');
const { defaultPrefix } = require('../config.json');

module.exports = {
  name: Events.ClientReady,
  once: true,
  async execute(client) {
    console.log(`Logged in as ${client.user.tag}! Serving ${client.guilds.cache.size} servers`);
    client.user.setActivity(`${defaultPrefix}help`, { type: ActivityType.Listening });

    // register the slash commands every startup, its only 2 of them anyway
    try {
      await client.application.commands.set(client.slashCommands.map((cmd) => cmd.data.toJSON()));
      console.log(`Registered ${client.slashCommands.size} slash commands`);
    } catch (err) {
      console.error('Failed to register slash commands', err);
    }
  },
};
