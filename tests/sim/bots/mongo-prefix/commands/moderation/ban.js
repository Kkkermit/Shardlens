const { PermissionFlagsBits } = require('discord.js');
const ModCase = require('../../models/ModCase');

module.exports = {
  name: 'ban',
  aliases: ['b', 'yeet'],
  description: 'Ban someone from the server',
  usage: '<@user> [reason]',
  guildOnly: true,
  async execute(message, args) {
    if (!message.member.permissions.has(PermissionFlagsBits.BanMembers)) {
      return message.reply('You need the Ban Members permission.');
    }

    const user = message.mentions.users.first();
    const reason = args.slice(1).join(' ') || 'No reason given';

    if (user.id === message.author.id) return message.reply("You can't ban yourself lol");

    await message.guild.members.ban(user.id, { reason: `${message.author.tag}: ${reason}` });
    await ModCase.create({
      guildId: message.guild.id,
      action: 'ban',
      userId: user.id,
      moderatorId: message.author.id,
      reason,
    });

    await message.reply(`🔨 Banned ${user}: ${reason}`);
  },
};
