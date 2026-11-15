import { container, Events, LogLevel, SapphireClient } from '@sapphire/framework';
import { startEmbeddedCollector } from '@shardlens/collector/embedded';
import { createShardlens, type Shardlens } from '@shardlens/discordjs';
import { GatewayIntentBits, Partials } from 'discord.js';
import { connectDatabase, disconnectDatabase, prefixFor } from './lib/settings.js';

declare module '@sapphire/pieces' {
  interface Container {
    lens: Shardlens;
  }
}

const client = new SapphireClient({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
  loadMessageCommandListeners: true,
  defaultPrefix: '!',
  fetchPrefix: (message) => prefixFor(message.guildId),
  logger: { level: LogLevel.Info },
});

const mongoUri = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/sapphire-bot';

// Unlike the SDK, the embedded collector can fail to start (a port in use, a folder it can't write to, a missing
// DISCORD_APP_ID). The bot then starts without analytics instead of not starting.
const collector = await startEmbeddedCollector({
  dataDir: './shardlens-data',
  appId: process.env.DISCORD_APP_ID ?? '',
  port: 8093,
  sink: { to: mongoUri },
}).catch((error: unknown) => {
  client.logger.error('Shardlens: the embedded collector did not start.', error);
  return undefined;
});
const lens = createShardlens(client, {
  endpoint: collector?.url,
  apiKey: collector?.ingestKey,
  release: process.env.npm_package_version,
});
container.lens = lens;

client.on(Events.ChatInputCommandRun, (interaction) => lens.handlerStarted(interaction));
client.on(Events.ChatInputCommandSuccess, ({ interaction, duration }) =>
  lens.handlerFinished(interaction, { durationMs: duration }),
);
client.on(Events.ChatInputCommandError, (error, { interaction, duration }) =>
  lens.handlerFinished(interaction, { durationMs: duration, error }),
);
client.on(Events.ContextMenuCommandRun, (interaction) => lens.handlerStarted(interaction));
client.on(Events.ContextMenuCommandSuccess, ({ interaction, duration }) =>
  lens.handlerFinished(interaction, { durationMs: duration }),
);
client.on(Events.ContextMenuCommandError, (error, { interaction, duration }) =>
  lens.handlerFinished(interaction, { durationMs: duration, error }),
);
client.on(Events.MessageCommandSuccess, ({ message, command, duration }) =>
  lens.trackMessageCommand(message, { command: command.name, durationMs: duration }),
);
client.on(Events.MessageCommandError, (error, { message, command, duration }) =>
  lens.trackMessageCommand(message, { command: command.name, durationMs: duration, error }),
);

async function main() {
  await connectDatabase(mongoUri);
  await client.login(process.env.DISCORD_TOKEN);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await lens.shutdown();
    await collector?.close();
    await client.destroy();
    await disconnectDatabase();
    process.exit(0);
  });
}

main().catch((error) => {
  client.logger.fatal(error);
  process.exit(1);
});
