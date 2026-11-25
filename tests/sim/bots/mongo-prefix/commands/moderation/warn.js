const { ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const Warning = require('../../models/Warning');

module.exports = {
  name: 'warn',
  aliases: ['w'],
  description: 'Warn a member (asks you to confirm first)',
  usage: '<@user> [reason]',
  guildOnly: true,
  async execute(message, args, client) {
    if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
      return message.reply('You need the Timeout Members permission to warn people.');
    }

    const user = message.mentions.users.first();
    if (!user) return message.reply('Who do you want to warn? Mention them.');
    const reason = args.slice(1).join(' ') || 'No reason given';

    const count = await Warning.countDocuments({ guildId: message.guild.id, userId: user.id });

    // saved when they press confirm (see events/interactionCreate.js)
    client.pendingWarns.set(message.author.id, { guildId: message.guild.id, userId: user.id, reason });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`confirm:warn:${message.author.id}`)
        .setLabel('Confirm')
        .setStyle(ButtonStyle.Danger),
    );
    await message.reply({ content: `Warn ${user}? They have ${count} warning(s) already.`, components: [row] });
  },
};
