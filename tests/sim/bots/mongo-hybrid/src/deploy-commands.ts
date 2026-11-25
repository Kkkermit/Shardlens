import { REST, Routes } from 'discord.js';
import { env } from './env';
import { loadCommands } from './handlers/loadCommands';

async function deploy() {
  if (!env.DISCORD_CLIENT_ID) throw new Error('Set DISCORD_CLIENT_ID in .env to deploy commands');
  const body = loadCommands().map((command) => command.data.toJSON());
  const rest = new REST().setToken(env.DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(env.DISCORD_CLIENT_ID), { body });
  console.log(`Deployed ${body.length} commands.`);
}

deploy().catch((err) => {
  console.error(err);
  process.exit(1);
});
