const { Events } = require('discord.js');
const { getPrefix } = require('../util/prefixes');

module.exports = {
  name: Events.MessageCreate,
  async execute(message, client) {
    if (message.author.bot) return;

    const prefix = await getPrefix(message.guildId);

    // someone just pinged the bot -> tell them the prefix
    const mention = message.content.trim();
    if (mention === `<@${client.user.id}>` || mention === `<@!${client.user.id}>`) {
      return message.reply(`My prefix here is \`${prefix}\` - try \`${prefix}help\``);
    }

    if (!message.content.startsWith(prefix)) return;

    const args = message.content.slice(prefix.length).trim().split(/ +/);
    const commandName = args.shift().toLowerCase();

    const command =
      client.commands.get(commandName) || client.commands.find((cmd) => cmd.aliases?.includes(commandName));
    if (!command) return;

    if (command.guildOnly && !message.guild) {
      return message.reply("I can't run that command inside DMs!");
    }

    try {
      await client.lens.wrapMessageCommand(command.name, (m) => command.execute(m, args, client))(message);
    } catch (error) {
      console.error(`Error running command ${command.name}:`, error);
      message.reply('There was an error trying to execute that command!').catch(() => {});
    }
  },
};
