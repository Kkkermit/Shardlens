import { compact, cutText, errorClass, errorCode, redactSecrets, uuidv7 } from '@shardlens/core';
import type { EventInput } from '@shardlens/schema';
import type { Message } from 'discord.js';
import type { ShardlensOptions } from './options.js';
import { auditActor, capturedValues, memberTier } from './run-details.js';
import { clampedInt, shardForGuild } from './util.js';

type MessageCommandInput = Extract<EventInput, { type: 'message_command' }>;

/** A command that ran from a message, as your bot's own parser understood it. */
export interface MessageCommandInfo {
  /** The command's name as your bot defines it, after aliases are resolved (`ban`, not what was typed). 1–32 characters. */
  command: string;
  /** Subcommand group, if the command has one. */
  group?: string | undefined;
  /** Subcommand, if the command has one. */
  sub?: string | undefined;
  /** Names of the arguments the user gave. */
  options?: readonly string[] | undefined;
  /**
   * Argument values. Only names listed in `captureOptionValues` are kept, never a value holding a Discord ID (pass a
   * mentioned user or channel as an argument name, not a value); strings are cut to 100 characters.
   */
  optionValues?: Readonly<Record<string, string | number | boolean>> | undefined;
}

/** How a message command went. */
export interface MessageCommandRun extends MessageCommandInfo {
  /** How long the handler took, in milliseconds. */
  durationMs?: number | undefined;
  /** What the handler threw, if anything. Only its class name and Discord error code are recorded. */
  error?: unknown;
  /** The command failed, but your bot caught the error itself. Implied when `error` is set. */
  failed?: boolean | undefined;
}

const name = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  // The length check first: redaction looks at the whole text, and a bot could pass a long string by mistake.
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 32) return undefined;
  return cutText(redactSecrets(trimmed), 32);
};

/**
 * Builds a `message_command` event from what the bot reports and the message's metadata. The message's content,
 * attachments and mentions are never read: the bot already parsed them and passes only the command it matched.
 */
export function describeMessageCommand(
  message: Message,
  run: MessageCommandRun,
  options: ShardlensOptions,
  shardCount: number,
): Omit<MessageCommandInput, 'user'> | undefined {
  const command = name(run.command);
  if (!command) return undefined;

  const failed = run.error !== undefined || run.failed === true;
  const code = run.error === undefined ? undefined : errorCode(run.error);

  return compact({
    id: uuidv7(message.createdTimestamp),
    ts: message.createdTimestamp,
    type: 'message_command' as const,
    command,
    group: name(run.group),
    sub: name(run.sub),
    options: (run.options ?? [])
      .map(name)
      .filter((o): o is string => o !== undefined)
      .slice(0, 25),
    optionValues: capturedValues(Object.entries(run.optionValues ?? {}), options.captureOptionValues),
    guild: message.guildId ?? undefined,
    channelType: message.channel?.type,
    guildLocale: message.guild?.preferredLocale ? String(message.guild.preferredLocale).slice(0, 10) : undefined,
    // An uncached member has no readable permissions: the tier is left out rather than guessed.
    memberTier: memberTier(message.inGuild(), message.member?.permissions, undefined),
    outcome: failed ? ('error' as const) : ('ok' as const),
    errorClass: run.error === undefined ? undefined : errorClass(run.error),
    errorCode: code,
    handlerMs: clampedInt(run.durationMs),
    shard: message.guild?.shardId ?? (message.guildId ? shardForGuild(message.guildId, shardCount) : 0),
    actor: auditActor(message.author, options),
  });
}
