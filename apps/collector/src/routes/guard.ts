import type { FastifyReply, FastifyRequest } from 'fastify';
import { bearerToken, readSession, type SessionAuth } from '../security/auth.js';
import type { Deps } from '../server.js';
import { allowedUser, hasCsrfHeader } from './auth.js';

/** An activity key reads everything a read key does, so a dashboard backend needs only one key. */
const READER_KEYS = ['read', 'activity'] as const;

/**
 * Who may read data: a dashboard session, a read or activity key, or anyone on a public demo collector
 * (`SHARDLENS_DEMO=true`). Sends 401 and returns `undefined` otherwise.
 */
export async function requireReader(deps: Deps, req: FastifyRequest, reply: FastifyReply): Promise<string | undefined> {
  const session = await readSession(deps.store, req);
  if (session) return session.appId;
  const key = await deps.keys.verify(bearerToken(req), READER_KEYS);
  if (key) return key.appId;
  if (deps.config.demo) return deps.config.appId;
  await reply.code(401).send({ error: 'unauthorized' });
  return undefined;
}

/**
 * Settings, keys and alerts need a person: a Discord session for the app owner or a team member (or an extra admin).
 * So does audit data in the dashboard; outside it, an activity key reads the activity log (`routes/privacy.ts`).
 * Read-key sessions can look at analytics but cannot change anything or see who ran what. State-changing requests
 * also need the CSRF header.
 */
export async function requireAdmin(
  deps: Deps,
  req: FastifyRequest,
  reply: FastifyReply,
  opts: { mutate?: boolean } = {},
): Promise<(SessionAuth & { userId: string }) | undefined> {
  const session = await readSession(deps.store, req);
  if (!session) {
    await reply.code(401).send({ error: 'unauthorized' });
    return undefined;
  }
  if (session.method !== 'discord' || !session.userId) {
    await reply.code(403).send({ error: 'discord_login_required' });
    return undefined;
  }
  // Checked on every request, not only at sign-in: someone taken off the team (or off SHARDLENS_EXTRA_ADMINS) loses
  // access as soon as the bot reports its new team, not when the session expires.
  if ((await allowedUser(deps, session.appId, session.userId)) !== 'ok') {
    await reply.code(403).send({ error: 'not_a_team_member' });
    return undefined;
  }
  if (opts.mutate && !hasCsrfHeader(req)) {
    await reply.code(403).send({ error: 'csrf' });
    return undefined;
  }
  return { ...session, userId: session.userId };
}
