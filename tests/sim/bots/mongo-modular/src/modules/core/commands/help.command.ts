import type { CommandRegistry } from '../../../framework/command-registry.js';
import { defineCommand, type PrefixResolver } from '../../../framework/types.js';

export const helpCommand = (registry: CommandRegistry, prefixes: PrefixResolver) =>
  defineCommand({
    name: 'help',
    description: 'List the message commands',
    category: 'core',
    aliases: ['commands', 'h'],
    prefix: {
      usage: '[command]',
      async run(message, [wanted]) {
        const prefix = await prefixes.resolve(message.guildId);

        if (wanted) {
          const command = registry.findPrefixCommand(wanted.toLowerCase());
          if (!command) return message.reply(`There is no \`${prefix}${wanted}\` command.`);
          const lines = [`**${prefix}${command.name}** ${command.prefix?.usage ?? ''}`, command.description];
          if (command.aliases?.length) lines.push(`Aliases: ${command.aliases.map((a) => `\`${a}\``).join(', ')}`);
          if (command.cooldown) lines.push(`Cooldown: ${command.cooldown}s`);
          return message.reply(lines.join('\n'));
        }

        const byCategory = new Map<string, string[]>();
        for (const command of registry.list()) {
          if (!command.prefix) continue;
          const category = command.category ?? 'other';
          byCategory.set(category, [...(byCategory.get(category) ?? []), `\`${prefix}${command.name}\``]);
        }
        const lines = [...byCategory].map(([category, names]) => `**${category}**: ${names.join(' ')}`);
        lines.push('', `Slash commands: type \`/\` to see them.`);
        return message.reply(lines.join('\n'));
      },
    },
  });
