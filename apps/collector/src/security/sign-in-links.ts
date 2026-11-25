import { createHash, randomBytes } from 'node:crypto';

const LINK_TTL_MS = 15 * 60_000;

/**
 * One-time sign-in links, for a dashboard someone runs from a terminal or inside their bot (`npx shardlens dashboard`,
 * the in-bot MongoDB runner). Whoever can see the link can already read the database the dashboard runs on, so the
 * link signs them in as the owner, settings included. Links live in this process's memory only: each works once,
 * within 15 minutes, and none survive a restart.
 */
export class SignInLinks {
  /** SHA-256 of each token, to its expiry. */
  readonly #pending = new Map<string, number>();

  /** A new link to `/auth/link/<token>` under `baseUrl`. */
  issue(baseUrl: string): string {
    const now = Date.now();
    for (const [hash, expires] of this.#pending) if (expires <= now) this.#pending.delete(hash);
    const token = randomBytes(32).toString('base64url');
    this.#pending.set(digest(token), now + LINK_TTL_MS);
    return new URL(`/auth/link/${token}`, baseUrl).href;
  }

  /** Whether the token is one this process issued, unused and not expired. It can't be used again either way. */
  redeem(token: string): boolean {
    const hash = digest(token);
    const expires = this.#pending.get(hash);
    this.#pending.delete(hash);
    return expires !== undefined && expires > Date.now();
  }
}

const digest = (token: string) => createHash('sha256').update(token).digest('hex');
