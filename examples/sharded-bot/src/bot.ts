// One shard process. Shardlens tags its events with client.shard.ids, so every shard reports separately and the
// dashboard adds them up. App-wide work (application info, registered commands) runs only where shard 0 lives.
import { createShardlens } from '@shardlens/discordjs';
import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const lens = createShardlens(client, {
  endpoint: process.env.SHARDLENS_URL ?? 'http://localhost:8080',
  apiKey: process.env.SHARDLENS_INGEST_KEY ?? '',
});

client.on(
  Events.InteractionCreate,
  lens.wrap(async (interaction) => {
    if (interaction.isChatInputCommand() && interaction.commandName === 'ping') {
      const shard = client.shard?.ids.join(', ') ?? '0';
      await interaction.reply({ content: `Pong from shard ${shard}`, flags: MessageFlags.Ephemeral });
    }
  }),
);

// The manager sends SIGTERM to shard processes when it stops; flush before exiting.
process.once('SIGTERM', async () => {
  await lens.shutdown({ timeoutMs: 2_000 });
  await client.destroy();
  process.exit(0);
});

await client.login(process.env.DISCORD_TOKEN);
