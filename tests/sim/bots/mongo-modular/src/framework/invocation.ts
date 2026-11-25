import {
  type CommandInteraction,
  type Message,
  type MessageComponentInteraction,
  MessageFlags,
  type ModalSubmitInteraction,
} from 'discord.js';
import type { CommandMeta, Invocation, InvocationSource } from './types.js';

type AnswerableInteraction = CommandInteraction | MessageComponentInteraction | ModalSubmitInteraction;

export function fromInteraction(
  source: Exclude<InvocationSource, 'prefix'>,
  interaction: AnswerableInteraction,
  meta: CommandMeta,
): Invocation {
  return {
    source,
    meta,
    guildId: interaction.guildId,
    userId: interaction.user.id,
    memberPermissions: interaction.memberPermissions,
    botPermissions: interaction.inGuild() ? interaction.appPermissions : null,
    respond: (content) =>
      interaction.replied || interaction.deferred
        ? interaction.followUp({ content, flags: MessageFlags.Ephemeral })
        : interaction.reply({ content, flags: MessageFlags.Ephemeral }),
  };
}

export function fromMessage(message: Message, meta: CommandMeta): Invocation {
  return {
    source: 'prefix',
    meta,
    guildId: message.guildId,
    userId: message.author.id,
    memberPermissions: message.member?.permissions ?? null,
    botPermissions: message.inGuild() ? (message.guild.members.me?.permissionsIn(message.channel) ?? null) : null,
    respond: (content) => message.reply({ content, allowedMentions: { repliedUser: false } }),
  };
}

export function describe(invocation: Invocation): string {
  const label = {
    slash: `/${invocation.meta.name}`,
    prefix: `prefix command "${invocation.meta.name}"`,
    'context-menu': `menu "${invocation.meta.name}"`,
    component: `component "${invocation.meta.name}"`,
  }[invocation.source];
  return `${label} ${invocation.guildId ? `in guild ${invocation.guildId}` : 'in DMs'}`;
}
