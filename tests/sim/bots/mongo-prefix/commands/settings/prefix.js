const { PermissionFlagsBits } = require('discord.js');
const { getPrefix, setPrefix } = require('../../util/prefixes');
const { maxPrefixLength } = require('../../config.json');

module.exports = {
  name: 'prefix',
  description: 'Show or change the prefix for this server',
  usage: '[new prefix]',
  guildOnly: true,
  async execute(message, args) {
    if (!args[0]) {
      const current = await getPrefix(message.guild.id);
      return message.reply(`The prefix here is \`${current}\``);
    }

    if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      return message.reply('You need the Manage Server permission to change the prefix.');
    }
    if (args[0].length > maxPrefixLength) {
      return message.reply(`The prefix can be at most ${maxPrefixLength} characters.`);
    }

    await setPrefix(message.guild.id, args[0]);
    return message.reply(`Prefix changed to \`${args[0]}\``);
  },
};
