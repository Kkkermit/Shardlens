import { SlashCommandBuilder } from 'discord.js';
import { echoCounts } from '../db.js';
import type { Command } from './index.js';

export default {
  data: new SlashCommandBuilder().setName('server').setDescription('Info about this server').setDMPermission(false),
  async run(interaction) {
    if (!interaction.inCachedGuild()) {
      await interaction.reply('Use this in a server!');
      return;
    }
    const echoes = await echoCounts().findOne({ guildId: interaction.guildId });
    await interaction.reply(
      `**${interaction.guild.name}** has ${interaction.guild.memberCount} members and has used /echo ${echoes?.count ?? 0} times.`,
    );
  },
} satisfies Command;
