import { GuildOnlyError } from '../../core/errors.js';
import type { Middleware } from '../middleware.js';

export const guildOnly = (): Middleware => async (invocation, next) => {
  if (invocation.meta.guildOnly && !invocation.guildId) throw new GuildOnlyError();
  await next();
};
