const { getPrefix } = require('../../util/prefixes');

module.exports = {
  name: 'help',
  aliases: ['h', 'commands'],
  description: 'Shows all commands',
  async execute(message, args, client) {
    const prefix = await getPrefix(message.guildId);

    if (args[0]) {
      const cmd = client.commands.get(args[0]) || client.commands.find((c) => c.aliases?.includes(args[0]));
      if (!cmd) return message.reply("That command doesn't exist.");
      let text = `**${prefix}${cmd.name}** - ${cmd.description || 'no description'}`;
      if (cmd.usage) text += `\nUsage: \`${prefix}${cmd.name} ${cmd.usage}\``;
      if (cmd.aliases?.length) text += `\nAliases: ${cmd.aliases.join(', ')}`;
      return message.reply(text);
    }

    const categories = {};
    for (const cmd of client.commands.values()) {
      if (!categories[cmd.category]) categories[cmd.category] = [];
      categories[cmd.category].push(`\`${prefix}${cmd.name}\``);
    }
    let text = '';
    for (const [category, cmds] of Object.entries(categories)) {
      text += `**${category}**: ${cmds.join(' ')}\n`;
    }
    text += `\nUse \`${prefix}help <command>\` for more info.`;
    return message.reply(text);
  },
};
