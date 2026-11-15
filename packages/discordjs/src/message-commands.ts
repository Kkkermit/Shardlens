import { avatarHash, compact, errorClass, errorCode, redactSecrets, uuidv7 } from '@shardlens/core';
import type { EventInput } from '@shardlens/schema';
import { type Message, PermissionFlagsBits } from 'discord.js';
import type { ShardlensOptions } from './options.js';
import { shardForGuild } from './util.js';

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
  /** Argument values. Only names listed in `captureOptionValues` are kept; strings are cut to 100 characters. */
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
  const clean = redactSecrets(value.trim());
  return clean.length > 0 && clean.length <= 32 ? clean : undefined;
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

  const allow = new Set(options.captureOptionValues ?? []);
  const values: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(run.optionValues ?? {})) {
    if (!allow.has(key) || key.length > 32) continue;
    if (typeof value === 'string') values[key] = redactSecrets(value).slice(0, 100);
    else if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) values[key] = value;
  }

  const permissions = message.member?.permissions;
  const memberTier = !message.inGuild()
    ? 'dm'
    : !permissions
      ? undefined
      : permissions.has(PermissionFlagsBits.Administrator)
        ? 'admin'
        : permissions.has(PermissionFlagsBits.ManageGuild)
          ? 'manager'
          : 'member';
  const failed = run.error !== undefined || run.failed === true;
  const code = run.error === undefined ? undefined : errorCode(run.error);
  const ms = typeof run.durationMs === 'number' && Number.isFinite(run.durationMs) ? run.durationMs : undefined;
  const profile = options.auditIncludeProfile !== false;

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
    optionValues: Object.keys(values).length > 0 ? values : undefined,
    guild: message.guildId ?? undefined,
    channelType: message.channel?.type,
    guildLocale: message.guild?.preferredLocale ? String(message.guild.preferredLocale).slice(0, 10) : undefined,
    memberTier: memberTier as MessageCommandInput['memberTier'],
    outcome: failed ? ('error' as const) : ('ok' as const),
    errorClass: run.error === undefined ? undefined : errorClass(run.error),
    errorCode: code,
    handlerMs: ms === undefined ? undefined : Math.max(0, Math.round(ms)),
    shard: message.guild?.shardId ?? (message.guildId ? shardForGuild(message.guildId, shardCount) : 0),
    actor:
      options.mode === 'audit'
        ? compact({
            userId: message.author.id,
            username: profile ? message.author.username.slice(0, 64) : undefined,
            avatar: profile ? avatarHash(message.author.avatar) : undefined,
          })
        : undefined,
  });
}
