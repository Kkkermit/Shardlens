import type {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  Collection,
  ContextMenuCommandBuilder,
  MessageContextMenuCommandInteraction,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandSubcommandsOnlyBuilder,
  UserContextMenuCommandInteraction,
} from 'discord.js';
import type { ClusterClient } from 'discord-hybrid-sharding';

export interface SlashCommand {
  type: 'slash';
  data: SlashCommandBuilder | SlashCommandOptionsOnlyBuilder | SlashCommandSubcommandsOnlyBuilder;
  execute(interaction: ChatInputCommandInteraction): Promise<void>;
  autocomplete?(interaction: AutocompleteInteraction): Promise<void>;
}

export interface UserMenuCommand {
  type: 'user';
  data: ContextMenuCommandBuilder;
  execute(interaction: UserContextMenuCommandInteraction): Promise<void>;
}

export interface MessageMenuCommand {
  type: 'message';
  data: ContextMenuCommandBuilder;
  execute(interaction: MessageContextMenuCommandInteraction): Promise<void>;
}

export type Command = SlashCommand | UserMenuCommand | MessageMenuCommand;

declare module 'discord.js' {
  interface Client {
    cluster: ClusterClient<Client>;
    commands: Collection<string, Command>;
  }
}
