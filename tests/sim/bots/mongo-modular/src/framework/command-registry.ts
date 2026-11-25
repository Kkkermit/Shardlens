import {
  ApplicationCommandType,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  ContextMenuCommandBuilder,
  type ContextMenuCommandInteraction,
  InteractionContextType,
  type Message,
  type RESTPostAPIApplicationCommandsJSONBody,
} from 'discord.js';
import type { ErrorHandler } from '../core/error-handler.js';
import type { Logger } from '../core/logger.js';
import { describe, fromInteraction, fromMessage } from './invocation.js';
import { compose, type Middleware } from './middleware.js';
import type { CommandDefinition, ContextMenuDefinition, Invocation } from './types.js';

export class CommandRegistry {
  private readonly commands = new Map<string, CommandDefinition>();
  private readonly aliases = new Map<string, string>();
  private readonly menus = new Map<string, ContextMenuDefinition>();
  private readonly middleware: Middleware[] = [];

  constructor(
    private readonly errors: ErrorHandler,
    private readonly logger: Logger,
  ) {}

  use(...middleware: Middleware[]): this {
    this.middleware.push(...middleware);
    return this;
  }

  add(command: CommandDefinition): this {
    if (this.commands.has(command.name)) throw new Error(`Command "${command.name}" is registered twice`);
    this.commands.set(command.name, command);
    for (const alias of command.aliases ?? []) {
      if (this.aliases.has(alias) || this.commands.has(alias)) {
        throw new Error(`Alias "${alias}" of "${command.name}" is already taken`);
      }
      this.aliases.set(alias, command.name);
    }
    return this;
  }

  addContextMenu(menu: ContextMenuDefinition): this {
    const key = `${menu.type}:${menu.name}`;
    if (this.menus.has(key)) throw new Error(`Context menu "${menu.name}" is registered twice`);
    this.menus.set(key, menu);
    return this;
  }

  list(): CommandDefinition[] {
    return [...this.commands.values()];
  }

  findPrefixCommand(name: string): CommandDefinition | undefined {
    const command = this.commands.get(name) ?? this.commands.get(this.aliases.get(name) ?? '');
    return command?.prefix ? command : undefined;
  }

  toApplicationCommands(): RESTPostAPIApplicationCommandsJSONBody[] {
    const slash = this.list().flatMap((command) => (command.slash ? [command.slash.data.toJSON()] : []));
    const menus = [...this.menus.values()].map((menu) =>
      new ContextMenuCommandBuilder()
        .setName(menu.name)
        .setType(menu.type === 'user' ? ApplicationCommandType.User : ApplicationCommandType.Message)
        .setContexts(menu.guildOnly ? [InteractionContextType.Guild] : [InteractionContextType.Guild, InteractionContextType.BotDM])
        .toJSON(),
    );
    return [...slash, ...menus];
  }

  async handleChatInput(interaction: ChatInputCommandInteraction): Promise<void> {
    const command = this.commands.get(interaction.commandName);
    if (!command?.slash) {
      this.logger.warn(`Received /${interaction.commandName}, which has no handler (stale registration?)`);
      return;
    }
    const { slash } = command;
    await this.execute(fromInteraction('slash', interaction, command), () => slash.run(interaction));
  }

  async handleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
    const autocomplete = this.commands.get(interaction.commandName)?.slash?.autocomplete;
    if (!autocomplete) return;
    try {
      await autocomplete(interaction);
    } catch (error) {
      this.logger.error(`Autocomplete for /${interaction.commandName} failed`, { error });
    }
  }

  async handleContextMenu(interaction: ContextMenuCommandInteraction): Promise<void> {
    const type = interaction.isUserContextMenuCommand() ? 'user' : 'message';
    const menu = this.menus.get(`${type}:${interaction.commandName}`);
    if (!menu) return;
    await this.execute(fromInteraction('context-menu', interaction, menu), async () => {
      if (menu.type === 'user' && interaction.isUserContextMenuCommand()) await menu.run(interaction);
      else if (menu.type === 'message' && interaction.isMessageContextMenuCommand()) await menu.run(interaction);
    });
  }

  /** Returns false when `name` isn't a prefix command, so the caller can ignore the message. */
  async handleMessage(message: Message, name: string, args: string[]): Promise<boolean> {
    const command = this.findPrefixCommand(name);
    if (!command?.prefix) return false;
    const { prefix } = command;
    await this.execute(fromMessage(message, command), () => prefix.run(message, args));
    return true;
  }

  private async execute(invocation: Invocation, handler: () => Promise<unknown>): Promise<void> {
    const started = performance.now();
    try {
      await compose(this.middleware, handler)(invocation);
      if (this.logger.isEnabled('debug')) {
        this.logger.debug(`${describe(invocation)} done in ${Math.round(performance.now() - started)}ms`);
      }
    } catch (error) {
      await this.errors.handle(error, invocation);
    }
  }
}
