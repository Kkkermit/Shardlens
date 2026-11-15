import { avatarHash, compact, redactSecrets } from '@shardlens/core';
import type { Actor } from '@shardlens/schema';
import { PermissionFlagsBits, type PermissionsBitField, type User } from 'discord.js';
import type { ShardlensOptions } from './options.js';

/**
 * What interactions and message commands both record about who ran them and with which options. One copy, because
 * each line decides what leaves the bot.
 */

type Tier = 'admin' | 'manager' | 'member' | 'dm';
type Value = string | number | boolean;

/** Admin, manager or member from the runner's permissions in the server, `dm` outside one, `unknown` when unreadable. */
export function memberTier(
  inGuild: boolean,
  permissions: Readonly<PermissionsBitField> | null | undefined,
  unknown: Tier | undefined,
): Tier | undefined {
  if (!inGuild) return 'dm';
  if (!permissions) return unknown;
  if (permissions.has(PermissionFlagsBits.Administrator)) return 'admin';
  return permissions.has(PermissionFlagsBits.ManageGuild) ? 'manager' : 'member';
}

/** Values of the options named in `captureOptionValues` only, with secrets redacted and strings cut to 100 characters. */
export function capturedValues(
  entries: Iterable<readonly [string, unknown]>,
  allow: readonly string[] | undefined,
): Record<string, Value> | undefined {
  if (!allow || allow.length === 0) return undefined;
  const allowed = new Set(allow);
  const values: Record<string, Value> = {};
  for (const [name, value] of entries) {
    if (!allowed.has(name) || name.length > 32) continue;
    if (typeof value === 'string') values[name] = redactSecrets(value).slice(0, 100);
    else if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) values[name] = value;
  }
  return Object.keys(values).length > 0 ? values : undefined;
}

/** Who ran it, in audit mode only: the user ID, plus username and avatar unless `auditIncludeProfile` is `false`. */
export function auditActor(
  user: Pick<User, 'id' | 'username' | 'avatar'>,
  options: ShardlensOptions,
): Actor | undefined {
  if (options.mode !== 'audit') return undefined;
  const profile = options.auditIncludeProfile !== false;
  return compact({
    userId: user.id,
    username: profile ? user.username.slice(0, 64) : undefined,
    avatar: profile ? avatarHash(user.avatar) : undefined,
  });
}
