import { Events, type Interaction, MessageFlags } from 'discord.js';
import { handleComponent } from '../components.js';

export default {
  name: Events.InteractionCreate,
  async execute(interaction: Interaction) {
    if (interaction.isChatInputCommand() && (await interaction.client.privacy.handle(interaction))) return;
    if (interaction.isAutocomplete()) {
      const command = interaction.client.commands.get(interaction.commandName);
      if (command && 'autocomplete' in command) await command.autocomplete?.(interaction);
      return;
    }
    if (interaction.isMessageComponent() || interaction.isModalSubmit()) {
      await handleComponent(interaction);
      return;
    }
    if (!interaction.isChatInputCommand() && !interaction.isContextMenuCommand()) return;

    const command = interaction.client.commands.get(interaction.commandName);
    if (!command) return;
    try {
      await interaction.client.lens.wrap((i: Interaction) => command.execute(i as never))(interaction);
    } catch (error) {
      console.error(`/${interaction.commandName} failed: ${(error as Error).message}`);
      const reply = { content: 'There was an error while running this command.', flags: MessageFlags.Ephemeral } as const;
      // The interaction may be gone (a reply after the deadline), so the error reply can fail too.
      if (interaction.replied || interaction.deferred) await interaction.followUp(reply).catch(() => {});
      else await interaction.reply(reply).catch(() => {});
    }
  },
};
