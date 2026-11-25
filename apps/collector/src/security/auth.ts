import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { SessionMethod, Store } from '../storage/store.js';
import { type ApiKeyScope, apiKeyScope } from './keys.js';

const SESSION_COOKIE = 'shardlens_session';
const SESSION_TTL_MS = 7 * 86_400_000;

export interface KeyAuth {
  keyId: string;
  appId: string;
  scope: ApiKeyScope;
}

export interface SessionAuth {
  appId: string;
  userId: string | null;
  /** `link`: opened with a one-time sign-in link (`security/sign-in-links.ts`). */
  method: SessionMethod;
  /** The read key a read-key session was opened with. */
  keyId?: string | undefined;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest();

export function bearerToken(req: FastifyRequest): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return undefined;
  const m = /^Bearer\s+(\S+)$/i.exec(header);
  return m?.[1];
}

const KEY_CACHE_MS = 60_000;
const MAX_CACHED_MISSES = 1_000;

/**
 * Validates API keys by SHA-256 lookup (keys are 32 random bytes, so the hash is the identifier and nothing about the
 * key leaks from timing). Results are cached for a minute; `last_used_at` is written at most once a minute. Unknown
 * keys are cached apart from known ones, so a flood of made-up keys can't push real keys out of the cache.
 */
export class KeyStore {
  readonly #store: Store;
  readonly #known = new Map<string, { auth: KeyAuth; at: number }>();
  readonly #unknown = new Map<string, number>();
  readonly #touched = new Map<string, number>();

  constructor(store: Store) {
    this.#store = store;
  }

  /** The key's record when it is known, not revoked and of `scope` (or one of several scopes). */
  async verify(
    presented: string | undefined,
    scope: ApiKeyScope | readonly ApiKeyScope[],
  ): Promise<KeyAuth | undefined> {
    const allowed: readonly ApiKeyScope[] = typeof scope === 'string' ? [scope] : scope;
    const claimed = presented ? apiKeyScope(presented) : undefined;
    if (!presented || !claimed || !allowed.includes(claimed)) return undefined;
    const digest = sha256(presented);
    const cacheKey = digest.toString('hex');
    const now = Date.now();
    if (now - (this.#unknown.get(cacheKey) ?? 0) <= KEY_CACHE_MS) return undefined;
    let entry = this.#known.get(cacheKey);
    if (!entry || now - entry.at > KEY_CACHE_MS) {
      const row = await this.#store.keys.findActive(digest);
      if (!row) {
        this.#known.delete(cacheKey);
        if (this.#unknown.size >= MAX_CACHED_MISSES) this.#unknown.clear();
        this.#unknown.set(cacheKey, now);
        return undefined;
      }
      entry = { auth: { keyId: row.id, appId: row.appId, scope: row.scope }, at: now };
      this.#known.set(cacheKey, entry);
    }
    if (!allowed.includes(entry.auth.scope)) return undefined;
    if (now - (this.#touched.get(entry.auth.keyId) ?? 0) > KEY_CACHE_MS) {
      this.#touched.set(entry.auth.keyId, now);
      void this.#store.keys.touch(entry.auth.keyId).catch(() => undefined);
    }
    return entry.auth;
  }

  /** Forgets cached results (after a key is revoked). */
  clear(): void {
    this.#known.clear();
    this.#unknown.clear();
  }
}

/**
 * Ensures a plaintext key from the environment exists in `api_keys` (stored as its SHA-256 only), labelled with its
 * variable. A new value revokes the key the variable held before: without the dashboard, changing the variable is the
 * only way to replace a leaked key. Only a key seen for the first time does this, so a collector instance still
 * started with the old value can't revoke the new one.
 */
export async function seedKey(store: Store, appId: string, plaintext: string, label: string): Promise<void> {
  const scope = apiKeyScope(plaintext);
  if (!scope) throw new Error(`${label} is not a valid Shardlens key`);
  await store.keys.ensureFromEnvironment({ appId, scope, sha256: sha256(plaintext), label });
}

export async function createSession(
  store: Store,
  reply: FastifyReply,
  session: SessionAuth,
  secure: boolean,
): Promise<void> {
  const token = randomBytes(32).toString('base64url');
  await store.sessions.create({
    idSha256: sha256(token),
    userId: session.userId,
    appId: session.appId,
    method: session.method,
    keyId: session.keyId ?? null,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export async function readSession(store: Store, req: FastifyRequest): Promise<SessionAuth | undefined> {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token || !/^[\w-]{43}$/.test(token)) return undefined;
  return store.sessions.find(sha256(token));
}

export async function destroySession(store: Store, req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) await store.sessions.delete(sha256(token));
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}
