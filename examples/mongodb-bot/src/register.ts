// Registers the example's slash commands globally. Run once: pnpm register
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error('DISCORD_TOKEN is required');
const rest = new REST().setToken(token);
const app = (await rest.get(Routes.currentApplication())) as { id: string };

const commands = [
  new SlashCommandBuilder().setName('ping').setDescription('Check the bot is alive'),
  new SlashCommandBuilder()
    .setName('roll')
    .setDescription('Roll a die')
    .addIntegerOption((o) => o.setName('sides').setDescription('Number of sides').setMinValue(2).setMaxValue(100)),
];
await rest.put(Routes.applicationCommands(app.id), { body: commands.map((c) => c.toJSON()) });
console.log(`Registered ${commands.length} commands for application ${app.id}`);
