import { createPrivacyCommand, createShardlens } from '@shardlens/discordjs';
import { Client, Events, GatewayIntentBits, REST, Routes } from 'discord.js';

// Your own storage for opt-outs (a database table, a JSON file…).
declare function loadOptOuts(): Promise<string[]>;
declare function saveOptOut(userId: string, optedOut: boolean): Promise<void>;

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const lens = createShardlens(client, {
  endpoint: process.env.SHARDLENS_URL!,
  apiKey: process.env.SHARDLENS_INGEST_KEY!,
  optedOut: await loadOptOuts(), // users who opted out before this restart
  // It may be async: a failed save is counted (see lens.on('error')), never thrown into your bot.
  onOptOutChange: (userId, optedOut) => saveOptOut(userId, optedOut),
});

const privacy = createPrivacyCommand(lens, { policyUrl: 'https://example.com/privacy' });

// Register it with your other commands (once, from a deploy script).
const rest = new REST().setToken(process.env.DISCORD_TOKEN!);
await rest.put(Routes.applicationCommands(process.env.DISCORD_APP_ID!), { body: [privacy.data] });

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isChatInputCommand() && (await privacy.handle(interaction))) return;
  // … your other commands
});
