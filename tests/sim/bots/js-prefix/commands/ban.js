const { PermissionFlagsBits } = require('discord.js');

module.exports = {
  name: 'ban',
  aliases: ['b', 'yeet'],
  async execute(message, args) {
    if (!message.member?.permissions.has(PermissionFlagsBits.BanMembers)) {
      await message.reply('You need the Ban Members permission.');
      return;
    }
    const target = args[0];
    const reason = args.slice(1).join(' ') || 'No reason given';
    if (!target) throw new Error('No user given');
    await message.reply(`Banned ${target}: ${reason}`);
  },
};
