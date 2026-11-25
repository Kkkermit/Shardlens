import {
  type ChatInputCommandInteraction,
  type Interaction,
  type MessageContextMenuCommandInteraction,
  MessageFlags,
  type UserContextMenuCommandInteraction,
} from 'discord.js';
import { handleComponent } from './components';

export async function onInteraction(interaction: Interaction) {
  const { lens } = interaction.client;

  if (interaction.isAutocomplete()) {
    const command = interaction.client.commands.get(interaction.commandName);
    if (command?.type !== 'slash' || !command.autocomplete) return;
    const autocomplete = command.autocomplete.bind(command);
    try {
      await lens.wrap(autocomplete)(interaction);
    } catch (error) {
      console.error(`Autocomplete for /${interaction.commandName} failed: ${(error as Error).message}`);
    }
    return;
  }

  if (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit()) {
    try {
      await lens.wrap(handleComponent)(interaction);
    } catch (error) {
      console.error(`Component ${interaction.customId.split(':').slice(0, 2).join(':')} failed: ${(error as Error).message}`);
    }
    return;
  }

  if (!interaction.isCommand()) return;
  const command = interaction.client.commands.get(interaction.commandName);
  if (!command) return;

  try {
    if (command.type === 'slash' && interaction.isChatInputCommand())
      await lens.wrap((i: ChatInputCommandInteraction) => command.execute(i))(interaction);
    else if (command.type === 'user' && interaction.isUserContextMenuCommand())
      await lens.wrap((i: UserContextMenuCommandInteraction) => command.execute(i))(interaction);
    else if (command.type === 'message' && interaction.isMessageContextMenuCommand())
      await lens.wrap((i: MessageContextMenuCommandInteraction) => command.execute(i))(interaction);
  } catch (error) {
    console.error(`[Cluster ${interaction.client.cluster.id}] ${interaction.commandName} failed: ${(error as Error).message}`);
    const reply = { content: 'Something went wrong while running this command.', flags: MessageFlags.Ephemeral } as const;
    // can fail too when the interaction already expired
    if (interaction.replied || interaction.deferred) await interaction.followUp(reply).catch(() => {});
    else await interaction.reply(reply).catch(() => {});
  }
}
