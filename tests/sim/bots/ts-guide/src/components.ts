import type { MessageComponentInteraction, ModalSubmitInteraction } from 'discord.js';

export async function handleComponent(interaction: MessageComponentInteraction | ModalSubmitInteraction) {
  if (interaction.isButton() && interaction.customId.startsWith('ticket:close:')) {
    await interaction.update({ content: 'Ticket closed.', components: [] });
  } else if (interaction.isStringSelectMenu() && interaction.customId === 'ticket:priority') {
    await interaction.reply({ content: `Priority set to ${interaction.values[0]}.`, ephemeral: true });
  } else if (interaction.isModalSubmit() && interaction.customId === 'feedback:form') {
    await interaction.reply({ content: 'Thanks for the feedback!', ephemeral: true });
  }
  // Anything else (old buttons from removed features) is ignored.
}
