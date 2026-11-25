import { PermissionFlagsBits } from 'discord.js';
import { defineCommand } from '../../../framework/types.js';
import type { SettingsService } from '../settings.service.js';

export const prefixCommand = (settings: SettingsService) =>
  defineCommand({
    name: 'prefix',
    description: "Show or change this server's prefix",
    category: 'settings',
    aliases: ['setprefix'],
    guildOnly: true,
    cooldown: 5,
    userPermissions: [PermissionFlagsBits.ManageGuild],
    prefix: {
      usage: '[new prefix]',
      async run(message, [next]) {
        const guildId = message.guildId!;
        if (!next) return message.reply(`The prefix here is \`${await settings.resolve(guildId)}\``);
        await settings.setPrefix(guildId, next);
        return message.reply(`Prefix changed to \`${next}\``);
      },
    },
  });
