const prefixes = require('../prefixes');

module.exports = {
  name: 'prefix',
  async execute(message, args) {
    if (!message.guildId) return;
    if (!args[0]) {
      await message.reply(`The prefix here is \`${prefixes.get(message.guildId)}\``);
      return;
    }
    prefixes.set(message.guildId, args[0]);
    await message.reply(`Prefix set to \`${args[0]}\``);
  },
};
