import { SlashCommandBuilder, time } from 'discord.js';
import { echoCounts, servers } from '../db.js';
import type { Command } from './index.js';

export default {
  data: new SlashCommandBuilder().setName('server').setDescription('Info about this server').setDMPermission(false),
  async run(interaction) {
    if (!interaction.inCachedGuild()) {
      await interaction.reply('Use this in a server!');
      return;
    }
    const { guild } = interaction;
    const [info, echoes] = await Promise.all([
      servers().findOneAndUpdate(
        { guildId: guild.id },
        {
          $set: { name: guild.name, memberCount: guild.memberCount, lastSeenAt: new Date() },
          $setOnInsert: { firstSeenAt: new Date() },
        },
        { upsert: true, returnDocument: 'after' },
      ),
      echoCounts().findOne({ guildId: guild.id }),
    ]);
    await interaction.reply(
      `**${guild.name}** has ${guild.memberCount} members and has used /echo ${echoes?.count ?? 0} times. ` +
        `I've known it since ${time(info?.firstSeenAt ?? new Date(), 'D')}.`,
    );
  },
} satisfies Command;
