import { Command } from '@sapphire/framework';
import type { Message } from 'discord.js';

export class PingCommand extends Command {
  public constructor(context: Command.LoaderContext, options: Command.Options) {
    super(context, { ...options, name: 'ping', aliases: ['pong'], description: 'Check the bot is alive' });
  }

  public override registerApplicationCommands(registry: Command.Registry) {
    registry.registerChatInputCommand((builder) => builder.setName(this.name).setDescription(this.description));
  }

  public override async messageRun(message: Message) {
    await message.reply('Pong!');
  }

  public override async chatInputRun(interaction: Command.ChatInputCommandInteraction) {
    await interaction.reply('Pong!');
  }
}
