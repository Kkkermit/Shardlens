import { InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { defineCommand } from '../../../framework/types.js';
import type { SettingsService } from '../settings.service.js';

export const settingsCommand = (settings: SettingsService) =>
  defineCommand({
    name: 'settings',
    description: 'View or change the server settings',
    category: 'settings',
    guildOnly: true,
    userPermissions: [PermissionFlagsBits.ManageGuild],
    slash: {
      data: new SlashCommandBuilder()
        .setName('settings')
        .setDescription('View or change the server settings')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .setContexts(InteractionContextType.Guild)
        .addSubcommand((sub) => sub.setName('view').setDescription('Show the current settings'))
        .addSubcommand((sub) =>
          sub
            .setName('prefix')
            .setDescription('Change the prefix for message commands')
            .addStringOption((option) =>
              option.setName('value').setDescription('The new prefix').setRequired(true).setMaxLength(5),
            ),
        ),
      async run(interaction) {
        const guildId = interaction.guildId!;
        if (interaction.options.getSubcommand() === 'prefix') {
          const value = interaction.options.getString('value', true);
          await settings.setPrefix(guildId, value);
          return interaction.reply({ content: `Prefix changed to \`${value}\``, flags: MessageFlags.Ephemeral });
        }
        const current = await settings.get(guildId);
        return interaction.reply({ content: `**Settings**\nPrefix: \`${current.prefix}\``, flags: MessageFlags.Ephemeral });
      },
    },
  });
