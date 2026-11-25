// Registers the slash commands globally. Run after changing any command's options: `npm run build && npm run deploy`
import { REST, Routes } from 'discord.js';
import { commands } from './commands/index.js';

const { DISCORD_TOKEN, CLIENT_ID } = process.env;
if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error('DISCORD_TOKEN and CLIENT_ID must be set');
  process.exit(1);
}

const body = [...commands.values()].map((command) => command.data.toJSON());
const rest = new REST().setToken(DISCORD_TOKEN);
const result = (await rest.put(Routes.applicationCommands(CLIENT_ID), { body })) as unknown[];
console.log(`Deployed ${result.length} commands`);
