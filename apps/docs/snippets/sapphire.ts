import { Events, SapphireClient } from '@sapphire/framework';
import { createShardlens } from '@shardlens/discordjs';
import { GatewayIntentBits } from 'discord.js';

const client = new SapphireClient({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  loadMessageCommandListeners: true,
});
const lens = createShardlens(client, {
  endpoint: process.env.SHARDLENS_URL,
  apiKey: process.env.SHARDLENS_INGEST_KEY,
});

// Sapphire runs your commands and announces each step; Shardlens listens. Interactions are recorded on their own:
// these add handler time and failures, as lens.wrap() would.
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

// Prefix commands: the command's name, never what was typed.
client.on(Events.MessageCommandSuccess, ({ message, command, duration }) =>
  lens.trackMessageCommand(message, { command: command.name, durationMs: duration }),
);
client.on(Events.MessageCommandError, (error, { message, command, duration }) =>
  lens.trackMessageCommand(message, { command: command.name, durationMs: duration, error }),
);

await client.login(process.env.DISCORD_TOKEN);
