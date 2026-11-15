import { type ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';

export default {
  data: new SlashCommandBuilder().setName('stats').setDescription('Servers across all shards'),
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply();
    const counts = (await interaction.client.shard?.fetchClientValues('guilds.cache.size')) as number[] | undefined;
    await interaction.editReply(`Servers: ${counts?.reduce((a, b) => a + b, 0) ?? interaction.client.guilds.cache.size}`);
  },
};
