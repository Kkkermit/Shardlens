import { ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder, StringSelectMenuBuilder } from 'discord.js';
import type { SlashCommand } from '../types.js';

const CATEGORIES = ['billing', 'bug', 'account', 'other'];

export default {
  data: new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Support tickets')
    .addSubcommand((s) =>
      s
        .setName('open')
        .setDescription('Open a ticket')
        .addStringOption((o) => o.setName('category').setDescription('Category').setRequired(true).setAutocomplete(true))
        .addStringOption((o) => o.setName('details').setDescription('What happened')),
    )
    .addSubcommand((s) => s.setName('list').setDescription('Your open tickets')),
  async autocomplete(interaction) {
    const typed = interaction.options.getFocused().toLowerCase();
    await interaction.respond(CATEGORIES.filter((c) => c.startsWith(typed)).map((c) => ({ name: c, value: c })));
  },
  async execute(interaction) {
    if (interaction.options.getSubcommand() === 'list') {
      await interaction.reply({ content: 'You have no open tickets.', ephemeral: true });
      return;
    }
    const category = interaction.options.getString('category', true);
    const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`ticket:close:${interaction.user.id}`).setLabel('Close').setStyle(ButtonStyle.Secondary),
    );
    const priority = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('ticket:priority')
        .addOptions({ label: 'Low', value: 'low' }, { label: 'High', value: 'high' }),
    );
    await interaction.reply({ content: `Ticket opened (${category}).`, components: [buttons, priority] });
  },
} satisfies SlashCommand;
