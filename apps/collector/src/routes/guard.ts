import type { FastifyReply, FastifyRequest } from 'fastify';
import { bearerToken, readSession, type SessionAuth } from '../security/auth.js';
import type { Deps } from '../server.js';
import { hasCsrfHeader } from './auth.js';

/**
 * Who may read data: a dashboard session or a read-scoped key, or anyone on a public demo collector
 * (`SHARDLENS_DEMO=true`). Sends 401 and returns `undefined` otherwise.
 */
export async function requireReader(deps: Deps, req: FastifyRequest, reply: FastifyReply): Promise<string | undefined> {
  const session = await readSession(deps.db, req);
  if (session) return session.appId;
  const key = await deps.keys.verify(bearerToken(req), 'read');
  if (key) return key.appId;
  if (deps.config.demo) return deps.config.appId;
  await reply.code(401).send({ error: 'unauthorized' });
  return undefined;
}

/**
 * Settings, keys, alerts and audit data need a person: a Discord session for the app owner or a team member (or an
 * extra admin). Read-key sessions can look at analytics but cannot change anything or see who ran what.
 * State-changing requests also need the CSRF header.
 */
export async function requireAdmin(
  deps: Deps,
  req: FastifyRequest,
  reply: FastifyReply,
  opts: { mutate?: boolean } = {},
): Promise<(SessionAuth & { userId: string }) | undefined> {
  const session = await readSession(deps.db, req);
  if (!session) {
    await reply.code(401).send({ error: 'unauthorized' });
    return undefined;
  }
  if (session.method !== 'discord' || !session.userId) {
    await reply.code(403).send({ error: 'discord_login_required' });
    return undefined;
  }
  if (opts.mutate && !hasCsrfHeader(req)) {
    await reply.code(403).send({ error: 'csrf' });
    return undefined;
  }
  return { ...session, userId: session.userId };
}

/** Writes an admin action to `admin_audit`. Details must never contain secrets. */
export async function adminAudit(deps: Deps, appId: string, userId: string | null, action: string, details: object) {
  await deps.db.query('INSERT INTO admin_audit (app_id, user_id, action, details) VALUES ($1, $2, $3, $4)', [
    appId,
    userId,
    action,
    JSON.stringify(details),
  ]);
}
