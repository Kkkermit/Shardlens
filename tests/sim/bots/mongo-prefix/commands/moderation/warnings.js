const Warning = require('../../models/Warning');

module.exports = {
  name: 'warnings',
  aliases: ['warns'],
  description: 'List the warnings of a member',
  usage: '[@user]',
  guildOnly: true,
  async execute(message) {
    const user = message.mentions.users.first() || message.author;
    const warnings = await Warning.find({ guildId: message.guild.id, userId: user.id }).sort({ createdAt: -1 }).limit(10);

    if (!warnings.length) return message.reply(`${user} has no warnings 🎉`);

    const lines = warnings.map((w, i) => `${i + 1}. ${w.reason} - <t:${Math.floor(w.createdAt.getTime() / 1000)}:R>`);
    return message.reply({ content: `Warnings for ${user}:\n${lines.join('\n')}`, allowedMentions: { users: [] } });
  },
};
