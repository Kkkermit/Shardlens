import { CooldownError } from '../../core/errors.js';
import type { Middleware } from '../middleware.js';

const SWEEP_ABOVE = 5_000;

/** Per user, per command, in memory. Fine while all shards live in one process. */
export function cooldowns(now: () => number = Date.now): Middleware {
  const expiresAt = new Map<string, number>();

  return async (invocation, next) => {
    const seconds = invocation.meta.cooldown ?? 0;
    if (seconds <= 0) return next();

    const key = `${invocation.meta.name}:${invocation.userId}`;
    const time = now();
    const until = expiresAt.get(key) ?? 0;
    if (until > time) throw new CooldownError(until - time);

    expiresAt.set(key, time + seconds * 1000);
    if (expiresAt.size > SWEEP_ABOVE) {
      for (const [entry, expiry] of expiresAt) if (expiry <= time) expiresAt.delete(entry);
    }
    await next();
  };
}
