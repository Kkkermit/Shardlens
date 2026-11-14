// Audit mode records who ran each interaction (encrypted, for support and abuse handling). It only takes effect when
// the collector is in audit mode too: set SHARDLENS_AUDIT_KEY on the collector and choose Settings → User identity → Identified.
// Tell your users: `npx shardlens privacy --audit` prints a matching privacy-policy paragraph.
import { createPrivacyCommand, createShardlens } from '@shardlens/discordjs';
import { Client, Events, GatewayIntentBits, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { loadOptOuts, saveOptOut } from './opt-outs.ts';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const lens = createShardlens(client, {
  endpoint: process.env.SHARDLENS_URL ?? 'http://localhost:8080',
  apiKey: process.env.SHARDLENS_INGEST_KEY ?? '',
  mode: 'audit',
  auditIncludeProfile: false, // IDs only: leave this out to also record usernames and avatars
  optedOut: await loadOptOuts(), // opt-outs survive restarts
  onOptOutChange: (userId, optedOut) => void saveOptOut(userId, optedOut).catch(console.error),
});

const privacy = createPrivacyCommand(lens, { policyUrl: process.env.PRIVACY_POLICY_URL || undefined });
const ping = new SlashCommandBuilder().setName('ping').setDescription('Check the bot is alive');

client.on(
  Events.InteractionCreate,
  lens.wrap(async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (await privacy.handle(interaction)) return;
    if (interaction.commandName === 'ping') {
      await interaction.reply({ content: 'Pong!', flags: MessageFlags.Ephemeral });
    }
  }),
);

client.once(Events.ClientReady, async (ready) => {
  if (process.argv.includes('--register')) {
    await ready.application.commands.set([ping.toJSON(), privacy.data]);
    console.log('Registered /ping and /privacy');
    await lens.shutdown();
    await client.destroy();
    return;
  }
  console.log(`Logged in as ${ready.user.tag} (audit mode)`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await lens.shutdown({ timeoutMs: 2_000 });
    await client.destroy();
    process.exit(0);
  });
}

await client.login(process.env.DISCORD_TOKEN);
