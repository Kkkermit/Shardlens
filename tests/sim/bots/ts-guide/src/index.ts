import { readdirSync } from 'node:fs';
import { createPrivacyCommand, createShardlens, type PrivacyCommand, type Shardlens } from '@shardlens/discordjs';
import { Client, Collection, GatewayIntentBits } from 'discord.js';
import { env } from './env.js';
import type { BotEvent, Command } from './types.js';

declare module 'discord.js' {
  interface Client {
    commands: Collection<string, Command>;
    lens: Shardlens;
    privacy: PrivacyCommand;
  }
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.commands = new Collection();
client.lens = createShardlens(client, {
  endpoint: env.SHARDLENS_URL,
  apiKey: env.SHARDLENS_INGEST_KEY,
  release: process.env.npm_package_version,
});
client.privacy = createPrivacyCommand(client.lens);

for (const file of readdirSync(new URL('./commands/', import.meta.url)).filter((f) => f.endsWith('.js'))) {
  const { default: command } = (await import(`./commands/${file}`)) as { default: Command };
  client.commands.set(command.data.name, command);
}

for (const file of readdirSync(new URL('./events/', import.meta.url)).filter((f) => f.endsWith('.js'))) {
  const { default: event } = (await import(`./events/${file}`)) as { default: BotEvent };
  const run = (...args: unknown[]) => event.execute(...(args as never[]));
  if (event.once) client.once(event.name, run);
  else client.on(event.name, run);
}

process.on('SIGINT', async () => {
  console.log('Shutting down');
  await client.lens.shutdown();
  await client.destroy();
  process.exit(0);
});

await client.login(env.DISCORD_TOKEN);
