// A bot that keeps its Shardlens data in its own MongoDB: one option, nothing else to run. `pnpm dashboard` opens it.
import { createShardlens } from '@shardlens/discordjs';
import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const lens = createShardlens(client, { mongodb: process.env.MONGODB_URI, release: '1.0.0' });

lens.on('error', (name) => console.warn(`[shardlens] internal error counted: ${name}`));

client.on(
  Events.InteractionCreate,
  lens.wrap(async (interaction) => {
    if (interaction.isChatInputCommand() && interaction.commandName === 'ping') {
      await interaction.reply({ content: 'Pong!', flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.isChatInputCommand() && interaction.commandName === 'roll') {
      const sides = interaction.options.getInteger('sides') ?? 6;
      await interaction.reply(`🎲 ${1 + Math.floor(Math.random() * sides)} (d${sides})`);
      lens.track('dice_rolled', { sides }, { userId: interaction.user.id, guildId: interaction.guildId ?? undefined });
    }
  }),
);

client.once(Events.ClientReady, (ready) => console.log(`Logged in as ${ready.user.tag}`));

// The SDK never handles signals itself: flush on your own shutdown path. This also closes its MongoDB connection.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await lens.shutdown({ timeoutMs: 2_000 });
    await client.destroy();
    process.exit(0);
  });
}

await client.login(process.env.DISCORD_TOKEN);
