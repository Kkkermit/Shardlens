import { SlashCommandBuilder } from 'discord.js';
import { spins } from '../db.js';
import type { Command } from './index.js';

export default {
  data: new SlashCommandBuilder()
    .setName('roulette')
    .setDescription('Bet on red or black')
    .addIntegerOption((option) =>
      option.setName('bet').setDescription('How many coins').setRequired(true).setMinValue(1).setMaxValue(1000),
    )
    .addStringOption((option) =>
      option
        .setName('color')
        .setDescription('Red or black (default red)')
        .addChoices({ name: 'Red', value: 'red' }, { name: 'Black', value: 'black' }),
    ),
  async run(interaction) {
    const bet = interaction.options.getInteger('bet', true);
    const color = (interaction.options.getString('color') ?? 'red') as 'red' | 'black';
    const landed = Math.random() < 0.5 ? 'red' : 'black';
    const won = landed === color;

    await spins().insertOne({
      guildId: interaction.guildId ?? 'dm',
      userId: interaction.user.id,
      bet,
      color,
      landed,
      won,
      at: new Date(),
    });

    await interaction.reply(
      won ? `🎉 It landed on **${landed}**, you win ${bet * 2} coins!` : `💀 It landed on **${landed}**. You lost ${bet} coins.`,
    );
  },
} satisfies Command;
