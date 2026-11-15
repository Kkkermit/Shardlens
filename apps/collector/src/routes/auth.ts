import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createSession, destroySession, readSession } from '../security/auth.js';
import { discordOAuth, randomToken } from '../security/discord-oauth.js';
import type { Deps } from '../server.js';

const STATE_COOKIE = 'shardlens_oauth_state';
const VERIFIER_COOKIE = 'shardlens_oauth_verifier';
const CSRF_HEADER = 'x-shardlens-csrf';

/**
 * State-changing requests made with a session cookie must carry this header. Browsers can't add custom headers to
 * cross-site form posts, and the collector sends no CORS headers, so a forged request can't include it (ADR 0010).
 */
export function hasCsrfHeader(req: FastifyRequest): boolean {
  return req.headers[CSRF_HEADER] === '1';
}

/**
 * Owner and team come from the bot's `app_info` event, so before the bot first reports nobody but an extra admin can
 * sign in with Discord. That case gets its own answer, so it doesn't read as "you are not on the team".
 */
export async function allowedUser(
  deps: Deps,
  appId: string,
  userId: string,
): Promise<'ok' | 'not_a_team_member' | 'bot_not_reported'> {
  if (deps.config.extraAdmins.includes(userId)) return 'ok';
  const res = await deps.db.query<{ ok: boolean }>(
    'SELECT $2::bigint = ANY(dashboard_user_ids) AS ok FROM app_info WHERE app_id = $1',
    [appId, userId],
  );
  const row = res.rows[0];
  if (!row) return 'bot_not_reported';
  return row.ok ? 'ok' : 'not_a_team_member';
}

export async function authRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const secure = deps.config.publicUrl.protocol === 'https:';
  const cookie = { httpOnly: true, secure, sameSite: 'lax' as const, path: '/auth', maxAge: 600, signed: true };
  const discord = deps.config.discord
    ? discordOAuth(deps.config.discord, new URL('/auth/discord/callback', deps.config.publicUrl).toString())
    : undefined;
  const authLimit = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };
  const fail = (reply: FastifyReply, reason: string) => reply.redirect(`/login?error=${encodeURIComponent(reason)}`);

  app.get('/auth/discord', authLimit, async (_req, reply) => {
    if (!discord) return reply.code(404).send({ error: 'discord_login_not_configured' });
    const state = randomToken();
    const verifier = randomToken();
    reply.setCookie(STATE_COOKIE, state, cookie);
    reply.setCookie(VERIFIER_COOKIE, verifier, cookie);
    return reply.redirect(discord.authorizationUrl(state, verifier).toString());
  });

  app.get('/auth/discord/callback', authLimit, async (req, reply) => {
    if (!discord) return reply.code(404).send({ error: 'discord_login_not_configured' });
    const query = req.query as { code?: unknown; state?: unknown };
    const stateCookie = req.unsignCookie(req.cookies[STATE_COOKIE] ?? '');
    const verifierCookie = req.unsignCookie(req.cookies[VERIFIER_COOKIE] ?? '');
    reply.clearCookie(STATE_COOKIE, { path: '/auth' });
    reply.clearCookie(VERIFIER_COOKIE, { path: '/auth' });
    if (
      typeof query.code !== 'string' ||
      typeof query.state !== 'string' ||
      !stateCookie.valid ||
      !verifierCookie.valid ||
      stateCookie.value !== query.state
    ) {
      return fail(reply, 'invalid_state');
    }
    let userId: string;
    try {
      const accessToken = await discord.accessToken(query.code, verifierCookie.value ?? '');
      const res = await fetch('https://discord.com/api/v10/users/@me', {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return fail(reply, 'discord_error');
      const user = (await res.json()) as { id?: unknown };
      if (typeof user.id !== 'string' || !/^\d{17,20}$/.test(user.id)) return fail(reply, 'discord_error');
      userId = user.id;
      // The Discord token is not stored anywhere: it goes out of scope here.
    } catch (error) {
      // The message names the OAuth error (for example invalid_client), never a code or token.
      req.log.warn({ reason: error instanceof Error ? error.message : 'unknown' }, 'Discord sign-in failed');
      return fail(reply, 'discord_error');
    }
    const allowed = await allowedUser(deps, deps.config.appId, userId);
    if (allowed === 'bot_not_reported') {
      req.log.warn(
        'Discord sign-in refused: the bot has not reported its owner and team yet. Start the bot with Shardlens, or add your Discord user ID to SHARDLENS_EXTRA_ADMINS',
      );
      return fail(reply, allowed);
    }
    if (allowed !== 'ok') {
      req.log.warn('Discord sign-in refused: not the application owner, a team member or an extra admin');
      return fail(reply, allowed);
    }
    await createSession(deps.db, reply, { appId: deps.config.appId, userId, method: 'discord' }, secure);
    await deps.db.query("INSERT INTO admin_audit (app_id, user_id, action) VALUES ($1, $2, 'login')", [
      deps.config.appId,
      userId,
    ]);
    return reply.redirect('/');
  });

  app.post('/auth/read-key', authLimit, async (req, reply) => {
    if (!hasCsrfHeader(req)) return reply.code(403).send({ error: 'csrf' });
    const key = (req.body as { key?: unknown } | undefined)?.key;
    const auth = await deps.keys.verify(typeof key === 'string' ? key.trim() : undefined, 'read');
    if (!auth) return reply.code(401).send({ error: 'invalid_key' });
    await createSession(
      deps.db,
      reply,
      { appId: auth.appId, userId: null, method: 'read_key', keyId: auth.keyId },
      secure,
    );
    await deps.db.query("INSERT INTO admin_audit (app_id, action) VALUES ($1, 'login_read_key')", [auth.appId]);
    return { ok: true };
  });

  app.post('/auth/logout', async (req, reply) => {
    if (!hasCsrfHeader(req)) return reply.code(403).send({ error: 'csrf' });
    await destroySession(deps.db, req, reply);
    return { ok: true };
  });

  app.get('/auth/me', async (req) => {
    const session = await readSession(deps.db, req);
    // A public demo lets visitors read without signing in; admin pages still need a Discord sign-in.
    const demo = deps.config.demo;
    return {
      authenticated: session !== undefined || demo,
      method: session?.method ?? (demo ? 'demo' : null),
      userId: session?.userId ?? null,
      discordLogin: discord !== undefined,
      demo,
    };
  });
}
