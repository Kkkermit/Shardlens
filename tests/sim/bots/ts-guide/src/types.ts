import type {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  ContextMenuCommandBuilder,
  ContextMenuCommandInteraction,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandSubcommandsOnlyBuilder,
} from 'discord.js';

export interface SlashCommand {
  data: SlashCommandBuilder | SlashCommandOptionsOnlyBuilder | SlashCommandSubcommandsOnlyBuilder;
  execute(interaction: ChatInputCommandInteraction): Promise<void>;
  autocomplete?(interaction: AutocompleteInteraction): Promise<void>;
}

export interface MenuCommand {
  data: ContextMenuCommandBuilder;
  execute(interaction: ContextMenuCommandInteraction): Promise<void>;
}

export type Command = SlashCommand | MenuCommand;

export interface BotEvent {
  name: string;
  once?: boolean;
  execute(...args: never[]): Promise<void> | void;
}
