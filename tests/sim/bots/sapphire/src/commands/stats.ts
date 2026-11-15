import { Command } from '@sapphire/framework';
import { ApplicationCommandType, type Message } from 'discord.js';

export class StatsCommand extends Command {
  public constructor(context: Command.LoaderContext, options: Command.Options) {
    super(context, { ...options, name: 'stats', aliases: ['st'], description: 'Member stats' });
  }

  public override registerApplicationCommands(registry: Command.Registry) {
    registry.registerContextMenuCommand((builder) => builder.setName('Stats').setType(ApplicationCommandType.User));
  }

  public override async messageRun(message: Message) {
    // A known bug: the stats service is down, so the prefix version always fails.
    throw new Error(`stats unavailable for ${message.guildId}`);
  }

  public override async contextMenuRun(interaction: Command.ContextMenuCommandInteraction) {
    await interaction.reply({ content: 'Stats card.', ephemeral: true });
  }
}
