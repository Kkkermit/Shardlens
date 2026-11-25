import { SlashCommandBuilder } from 'discord.js';
import { echoCounts } from '../db.js';
import type { Command } from './index.js';

export default {
  data: new SlashCommandBuilder().setName('stats').setDescription('Bot stats across all shards'),
  async run(interaction) {
    await interaction.deferReply();

    const perShard = (await interaction.client.shard?.broadcastEval((c) => ({
      guilds: c.guilds.cache.size,
      members: c.guilds.cache.reduce((sum, g) => sum + g.memberCount, 0),
    }))) ?? [{ guilds: interaction.client.guilds.cache.size, members: 0 }];
    const guilds = perShard.reduce((sum, s) => sum + s.guilds, 0);
    const members = perShard.reduce((sum, s) => sum + s.members, 0);

    const [echoTotal] = await echoCounts()
      .aggregate<{ total: number }>([{ $group: { _id: null, total: { $sum: '$count' } } }])
      .toArray();

    await interaction.editReply(
      [
        `Shards: ${perShard.length}`,
        `Servers: ${guilds}`,
        `Members: ${members}`,
        `Echoes: ${echoTotal?.total ?? 0}`,
        `Memory (this shard): ${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB`,
      ].join('\n'),
    );
  },
} satisfies Command;
