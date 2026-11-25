import {
  type ButtonInteraction,
  MessageFlags,
  type ModalSubmitInteraction,
  PermissionFlagsBits,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { env } from '../env';
import { Feedback } from '../models/Feedback';
import { Ticket } from '../models/Ticket';

async function closeTicket(interaction: ButtonInteraction) {
  const ownerId = interaction.customId.split(':')[2];
  const isStaff =
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages) ||
    (env.STAFF_ROLE_ID && interaction.inCachedGuild() && interaction.member.roles.cache.has(env.STAFF_ROLE_ID));

  if (interaction.user.id !== ownerId && !isStaff) {
    await interaction.reply({ content: 'Only the person who opened this ticket (or staff) can close it.', flags: MessageFlags.Ephemeral });
    return;
  }

  const ticket = await Ticket.findOneAndUpdate(
    { guildId: interaction.guildId, userId: ownerId, status: 'open' },
    { status: 'closed', closedBy: interaction.user.id, closedAt: new Date() },
    { sort: { createdAt: -1 }, returnDocument: 'after' },
  );
  await interaction.update({ content: ticket ? `Ticket #${ticket.number} closed.` : 'Ticket closed.', components: [] });
}

async function setPriority(interaction: StringSelectMenuInteraction) {
  const priority = interaction.values[0];
  // the menu doesn't know which ticket it belongs to, so use the newest one of whoever picked
  await Ticket.findOneAndUpdate({ guildId: interaction.guildId, userId: interaction.user.id }, { priority }, { sort: { createdAt: -1 } });
  await interaction.reply({ content: `Priority set to ${priority}.`, flags: MessageFlags.Ephemeral });
}

async function saveFeedback(interaction: ModalSubmitInteraction) {
  const text = interaction.fields.getTextInputValue('text');
  await Feedback.create({ guildId: interaction.guildId, userId: interaction.user.id, text });
  await interaction.reply({ content: 'Thanks for the feedback!', flags: MessageFlags.Ephemeral });
}

export async function handleComponent(interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction) {
  if (interaction.isButton() && interaction.customId.startsWith('ticket:close:')) return closeTicket(interaction);
  if (interaction.isStringSelectMenu() && interaction.customId === 'ticket:priority') return setPriority(interaction);
  if (interaction.isModalSubmit() && interaction.customId === 'feedback:form') return saveFeedback(interaction);
  // anything else is a leftover from old versions (e.g. the vote buttons), just ignore it
}
