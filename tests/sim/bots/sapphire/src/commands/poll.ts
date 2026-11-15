import { Command } from '@sapphire/framework';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

export class PollCommand extends Command {
  public constructor(context: Command.LoaderContext, options: Command.Options) {
    super(context, { ...options, name: 'poll', description: 'Start a yes/no poll' });
  }

  public override registerApplicationCommands(registry: Command.Registry) {
    registry.registerChatInputCommand((builder) =>
      builder
        .setName(this.name)
        .setDescription(this.description)
        .addStringOption((o) => o.setName('question').setDescription('The question').setRequired(true)),
    );
  }

  public override async chatInputRun(interaction: Command.ChatInputCommandInteraction) {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('poll:yes').setLabel('Yes').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('poll:no').setLabel('No').setStyle(ButtonStyle.Danger),
    );
    await interaction.reply({ content: interaction.options.getString('question', true), components: [row] });
  }
}
