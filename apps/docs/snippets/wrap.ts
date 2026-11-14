import type { Shardlens } from '@shardlens/discordjs';
import { type Client, Events, MessageFlags } from 'discord.js';

declare const client: Client;
declare const lens: Shardlens;

client.on(
  Events.InteractionCreate,
  lens.wrap(async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === 'ping') {
      await interaction.reply({ content: 'Pong!', flags: MessageFlags.Ephemeral });
    }
    // An error thrown here is recorded (class and Discord code, never the message) and then re-thrown unchanged.
  }),
);

// Errors caught inside the SDK itself are counted, never thrown. Listen if you want to log them.
lens.on('error', (name) => console.warn(`[shardlens] internal error: ${name}`));
