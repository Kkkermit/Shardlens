// A minimal bot with Shardlens: the Guilds intent only, three lines of setup, one wrapped handler, one custom event.
import { createShardlens } from '@shardlens/discordjs';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
} from 'discord.js';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const lens = createShardlens(client, {
  endpoint: process.env.SHARDLENS_URL ?? 'http://localhost:8080',
  apiKey: process.env.SHARDLENS_INGEST_KEY ?? '',
  release: '1.0.0',
  captureOptionValues: ['sides'], // option values are recorded only for allow-listed options
});

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
      const value = 1 + Math.floor(Math.random() * sides);
      const again = new ButtonBuilder()
        .setCustomId(`roll:again:${sides}`)
        .setLabel('Roll again')
        .setStyle(ButtonStyle.Primary);
      await interaction.reply({
        content: `🎲 ${value} (d${sides})`,
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(again)],
      });
      lens.track('dice_rolled', { sides }, { userId: interaction.user.id, guildId: interaction.guildId ?? undefined });
      return;
    }
    if (interaction.isButton() && interaction.customId.startsWith('roll:again:')) {
      const sides = Number(interaction.customId.split(':')[2]) || 6;
      await interaction.update({ content: `🎲 ${1 + Math.floor(Math.random() * sides)} (d${sides})` });
    }
  }),
);

client.once(Events.ClientReady, (ready) => console.log(`Logged in as ${ready.user.tag}`));

// The SDK never handles signals itself: flush on your own shutdown path.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await lens.shutdown({ timeoutMs: 2_000 });
    await client.destroy();
    process.exit(0);
  });
}

await client.login(process.env.DISCORD_TOKEN);
