import type {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  Message,
  MessageComponentInteraction,
  MessageContextMenuCommandInteraction,
  ModalSubmitInteraction,
  PermissionsBitField,
  SharedSlashCommand,
  UserContextMenuCommandInteraction,
} from 'discord.js';

/** What middleware needs to know about a command. */
export interface CommandMeta {
  readonly name: string;
  readonly description: string;
  readonly category?: string;
  readonly aliases?: readonly string[];
  readonly guildOnly?: boolean;
  /** Seconds a user has to wait between two uses. */
  readonly cooldown?: number;
  readonly userPermissions?: readonly bigint[];
  readonly botPermissions?: readonly bigint[];
}

/** A command can be a slash command, a prefix command or both, sharing the same middleware settings. */
export interface CommandDefinition extends CommandMeta {
  readonly slash?: {
    readonly data: SharedSlashCommand;
    run(interaction: ChatInputCommandInteraction): Promise<unknown>;
    autocomplete?(interaction: AutocompleteInteraction): Promise<unknown>;
  };
  readonly prefix?: {
    readonly usage?: string;
    run(message: Message, args: string[]): Promise<unknown>;
  };
}

export type ContextMenuDefinition = CommandMeta &
  (
    | { readonly type: 'user'; run(interaction: UserContextMenuCommandInteraction): Promise<unknown> }
    | { readonly type: 'message'; run(interaction: MessageContextMenuCommandInteraction): Promise<unknown> }
  );

export type ComponentInteraction = MessageComponentInteraction | ModalSubmitInteraction;

export interface ComponentHandler {
  /** Handles custom IDs equal to `id` or starting with `id:`. */
  readonly id: string;
  run(interaction: ComponentInteraction): Promise<unknown>;
}

export type InvocationSource = 'slash' | 'prefix' | 'context-menu' | 'component';

/** One run of a command or component, whatever triggered it. Middleware and the error handler only see this. */
export interface Invocation {
  readonly source: InvocationSource;
  readonly meta: CommandMeta;
  readonly guildId: string | null;
  readonly userId: string;
  readonly memberPermissions: Readonly<PermissionsBitField> | null;
  readonly botPermissions: Readonly<PermissionsBitField> | null;
  /** Tells the user something: ephemerally for interactions, as a reply for messages. */
  respond(content: string): Promise<unknown>;
}

export interface PrefixResolver {
  /** The prefix for a server, or the default one in DMs (`null`). */
  resolve(guildId: string | null): Promise<string>;
}

export const defineCommand = (definition: CommandDefinition): CommandDefinition => definition;
export const defineContextMenu = (definition: ContextMenuDefinition): ContextMenuDefinition => definition;
export const defineComponent = (handler: ComponentHandler): ComponentHandler => handler;
