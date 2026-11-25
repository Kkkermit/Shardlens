import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
} from 'discord.js';
import { nextTicketNumber, ticketCategories } from '../models/GuildSettings';
import { Ticket } from '../models/Ticket';
import type { SlashCommand } from '../types';

const command: SlashCommand = {
  type: 'slash',
  data: new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Support tickets')
    .setDMPermission(false)
    .addSubcommand((sub) =>
      sub
        .setName('open')
        .setDescription('Open a new ticket')
        .addStringOption((o) =>
          o.setName('category').setDescription('What is it about?').setRequired(true).setAutocomplete(true),
        )
        .addStringOption((o) => o.setName('details').setDescription('Tell us what happened').setMaxLength(1000)),
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('Your open tickets')),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused().toLowerCase();
    const categories = await ticketCategories(interaction.guildId!);
    await interaction.respond(
      categories
        .filter((c) => c.startsWith(focused))
        .slice(0, 25)
        .map((c) => ({ name: c, value: c })),
    );
  },

  async execute(interaction) {
    const guildId = interaction.guildId!;

    if (interaction.options.getSubcommand() === 'list') {
      const open = await Ticket.find({ guildId, userId: interaction.user.id, status: 'open' }).sort({ number: 1 }).lean();
      await interaction.reply({
        content: open.length
          ? `Your open tickets:\n${open.map((t) => `• #${t.number} (${t.category}, ${t.priority})`).join('\n')}`
          : 'You have no open tickets.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const category = interaction.options.getString('category', true);
    const details = interaction.options.getString('details') ?? '';
    const number = await nextTicketNumber(guildId);
    await Ticket.create({ guildId, number, userId: interaction.user.id, category, details });

    const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`ticket:close:${interaction.user.id}`)
        .setLabel('Close ticket')
        .setStyle(ButtonStyle.Secondary),
    );
    const priority = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('ticket:priority')
        .setPlaceholder('Set a priority')
        .addOptions(
          { label: 'Low', value: 'low' },
          { label: 'Normal', value: 'normal' },
          { label: 'High', value: 'high' },
        ),
    );

    await interaction.reply({
      content: `🎫 Ticket #${number} opened (${category}). A staff member will be with you soon.`,
      components: [buttons, priority],
    });
  },
};

export default command;
