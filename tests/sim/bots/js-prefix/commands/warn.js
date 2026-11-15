const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

module.exports = {
  name: 'warn',
  aliases: ['w'],
  async execute(message, args) {
    const target = args[0] ?? 'someone';
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`confirm:warn:${message.author.id}`).setLabel('Confirm').setStyle(ButtonStyle.Danger),
    );
    await message.reply({ content: `Warn ${target}?`, components: [row] });
  },
};
