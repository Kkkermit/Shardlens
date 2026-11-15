// The layout from the discord.js guide: one file per command with `execute`, one `interactionCreate` file, and the
// client created in index.ts. `lens` travels on the client, so every file reaches it as `interaction.client.lens`.
import { createShardlens, type Shardlens } from '@shardlens/discordjs';
import {
  type ChatInputCommandInteraction,
  Client,
  Collection,
  Events,
  GatewayIntentBits,
  MessageFlags,
} from 'discord.js';

declare module 'discord.js' {
  interface Client {
    lens: Shardlens;
    commands: Collection<string, { execute(interaction: ChatInputCommandInteraction): Promise<void> }>;
  }
}

// index.ts
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.commands = new Collection();
client.lens = createShardlens(client, {
  endpoint: process.env.SHARDLENS_URL,
  apiKey: process.env.SHARDLENS_INGEST_KEY,
});

// events/interactionCreate.ts
const interactionCreate = {
  name: Events.InteractionCreate,
  async execute(interaction: ChatInputCommandInteraction) {
    const command = interaction.client.commands.get(interaction.commandName);
    if (!command) return;
    try {
      // Wrapped inside the try, so the error reaches Shardlens on its way to your catch.
      await interaction.client.lens.wrap((i: ChatInputCommandInteraction) => command.execute(i))(interaction);
    } catch {
      const reply = {
        content: 'There was an error while running this command.',
        flags: MessageFlags.Ephemeral,
      } as const;
      if (interaction.replied || interaction.deferred) await interaction.followUp(reply);
      else await interaction.reply(reply);
    }
  },
};

export { interactionCreate };
