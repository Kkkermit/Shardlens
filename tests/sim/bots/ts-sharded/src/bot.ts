import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createShardlens } from '@shardlens/discordjs';
import { Client, Collection, GatewayIntentBits } from 'discord.js';
import type { Command } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.commands = new Collection();
client.lens = createShardlens(client, {
  endpoint: process.env.SHARDLENS_URL,
  apiKey: process.env.SHARDLENS_INGEST_KEY,
  release: process.env.npm_package_version,
});

const foldersPath = path.join(__dirname, 'commands');
for (const folder of fs.readdirSync(foldersPath)) {
  const commandsPath = path.join(foldersPath, folder);
  for (const file of fs.readdirSync(commandsPath).filter((f) => f.endsWith('.js'))) {
    const { default: command } = (await import(pathToFileURL(path.join(commandsPath, file)).href)) as { default: Command };
    if ('data' in command && 'execute' in command) client.commands.set(command.data.name, command);
    else console.log(`[WARNING] The command at ${file} is missing a required "data" or "execute" property.`);
  }
}

const eventsPath = path.join(__dirname, 'events');
for (const file of fs.readdirSync(eventsPath).filter((f) => f.endsWith('.js'))) {
  const { default: event } = await import(pathToFileURL(path.join(eventsPath, file)).href);
  if (event.once) client.once(event.name, (...args) => event.execute(...args));
  else client.on(event.name, (...args) => event.execute(...args));
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await client.lens.shutdown();
    await client.destroy();
    process.exit(0);
  });
}

await client.login(process.env.DISCORD_TOKEN);
