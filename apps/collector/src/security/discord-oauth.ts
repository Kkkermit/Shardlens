import { createHash, randomBytes } from 'node:crypto';

const AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';
const TOKEN_URL = 'https://discord.com/api/oauth2/token';

/** A value nobody can guess, for the OAuth `state` and the PKCE code verifier: 32 random bytes as base64url. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Discord sign-in: the OAuth 2.0 authorization-code flow with PKCE (S256), asking for the `identify` scope only. The
 * collector needs to learn one thing, the user's ID, so the access token is used once and never stored.
 */
export function discordOAuth(app: { clientId: string; clientSecret: string }, redirectUri: string) {
  return {
    /** Where to send the browser. `verifier` stays in a cookie; Discord only sees its SHA-256. */
    authorizationUrl(state: string, verifier: string): URL {
      const url = new URL(AUTHORIZE_URL);
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: app.clientId,
        redirect_uri: redirectUri,
        state,
        code_challenge_method: 'S256',
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        scope: 'identify',
      }).toString();
      return url;
    },

    /**
     * Exchanges the code Discord sent back for an access token. Throws an `Error` whose message is Discord's OAuth
     * error name (`invalid_grant`, `invalid_client`) or a plain description: never the code, the secret or a token.
     */
    async accessToken(code: string, verifier: string): Promise<string> {
      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString('base64')}`,
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          code_verifier: verifier,
        }),
        // The secret goes to discord.com only: a redirect elsewhere is refused, not followed.
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await res.json().catch(() => undefined)) as { access_token?: unknown; error?: unknown } | undefined;
      if (res.ok && typeof body?.access_token === 'string' && body.access_token !== '') return body.access_token;
      const named = typeof body?.error === 'string' && /^[a-z_]{1,40}$/.test(body.error) ? body.error : undefined;
      throw new Error(named ?? `unexpected answer from Discord (${res.status})`);
    },
  };
}
