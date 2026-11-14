import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ApplicationIntegrationType,
  type ChatInputCommandInteraction,
  InteractionContextType,
  MessageFlags,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import type { Shardlens } from './index.js';

export interface PrivacyCommandOptions {
  name?: string | undefined;
  /** Link to your bot's privacy policy, shown in `/privacy info`. */
  policyUrl?: string | undefined;
}

export interface PrivacyCommand {
  /** Command definition to register with Discord (`rest.put(Routes.applicationCommands(id), { body: [data] })`). */
  data: RESTPostAPIChatInputApplicationCommandsJSONBody;
  /** Handles the command. Returns `false` for interactions that aren't this command. Never throws. */
  handle(interaction: ChatInputCommandInteraction): Promise<boolean>;
}

/**
 * A ready-made `/privacy` command: `info` explains what is collected, `optout` and `optin` stop and resume collection
 * for the user, `erase` deletes what was stored about them and opts them out. Replies are ephemeral. Opt-outs live in
 * memory: persist them with `onOptOutChange` and pass them back with `optedOut`.
 */
export function createPrivacyCommand(lens: Shardlens, options: PrivacyCommandOptions = {}): PrivacyCommand {
  const name = options.name ?? 'privacy';
  // Plain command JSON rather than a builder: discord.js 15 no longer re-exports the builders.
  const sub = (subName: string, description: string) => ({
    type: ApplicationCommandOptionType.Subcommand as const,
    name: subName,
    description,
  });
  const data: RESTPostAPIChatInputApplicationCommandsJSONBody = {
    type: ApplicationCommandType.ChatInput,
    name,
    description: 'How this bot handles your data',
    contexts: [InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel],
    integration_types: [ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall],
    options: [
      sub('info', 'What this bot records about you'),
      sub('optout', 'Stop recording your usage of this bot'),
      sub('optin', 'Allow usage recording again'),
      sub('erase', 'Delete what was recorded about you and opt out'),
    ],
  };

  const reply = (i: ChatInputCommandInteraction, content: string) =>
    i.replied || i.deferred
      ? i.editReply({ content })
      : i.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });

  return {
    data,
    async handle(i) {
      if (i.commandName !== name) return false;
      try {
        const sub = i.options.getSubcommand(false);
        const userId = i.user.id;
        if (sub === 'optout') {
          lens.optOut(userId);
          await reply(i, `Done. Your use of this bot is no longer recorded. Use \`/${name} optin\` to change this.`);
        } else if (sub === 'optin') {
          lens.optIn(userId);
          await reply(i, 'Thanks. Usage recording is back on for you.');
        } else if (sub === 'erase') {
          // Opt out first, so this command itself is not recorded after the erasure it asks for.
          lens.optOut(userId);
          await i.deferReply({ flags: MessageFlags.Ephemeral });
          const result = await lens.forgetUser(userId);
          await reply(
            i,
            result
              ? 'Your recorded usage has been deleted, and you are opted out of further recording.'
              : 'You are opted out of further recording. Deleting past records failed; please try again later or contact the bot owner.',
          );
        } else {
          const audit = lens.client.mode === 'audit';
          const lines = [
            '**What this bot records**',
            '• Which commands, buttons and menus are used, when, where (server, DM) and whether they worked.',
            audit
              ? '• Your Discord user ID (encrypted) with each command, kept for a limited time for support and abuse handling.'
              : '• A pseudonymous code instead of your user ID. It changes regularly and cannot be traced back to you afterwards.',
            '• Never your messages.',
            lens.isOptedOut(userId)
              ? '\nYou are currently **opted out**.'
              : `\nOpt out any time with \`/${name} optout\`.`,
            options.policyUrl ? `\nPrivacy policy: ${options.policyUrl}` : '',
          ];
          await reply(i, lines.join('\n'));
        }
      } catch (error) {
        lens.client.count('privacyCommand', error);
      }
      return true;
    },
  };
}
