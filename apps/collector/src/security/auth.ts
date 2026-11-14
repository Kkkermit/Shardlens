import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db.js';
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
  method: 'discord' | 'read_key';
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
  readonly #db: Db;
  readonly #known = new Map<string, { auth: KeyAuth; at: number }>();
  readonly #unknown = new Map<string, number>();
  readonly #touched = new Map<string, number>();

  constructor(db: Db) {
    this.#db = db;
  }

  async verify(presented: string | undefined, scope: ApiKeyScope): Promise<KeyAuth | undefined> {
    if (!presented || apiKeyScope(presented) !== scope) return undefined;
    const digest = sha256(presented);
    const cacheKey = digest.toString('hex');
    const now = Date.now();
    if (now - (this.#unknown.get(cacheKey) ?? 0) <= KEY_CACHE_MS) return undefined;
    let entry = this.#known.get(cacheKey);
    if (!entry || now - entry.at > KEY_CACHE_MS) {
      const res = await this.#db.query<{ id: string; app_id: string; scope: ApiKeyScope }>(
        'SELECT id, app_id, scope FROM api_keys WHERE sha256 = $1 AND revoked_at IS NULL',
        [digest],
      );
      const row = res.rows[0];
      if (!row) {
        this.#known.delete(cacheKey);
        if (this.#unknown.size >= MAX_CACHED_MISSES) this.#unknown.clear();
        this.#unknown.set(cacheKey, now);
        return undefined;
      }
      entry = { auth: { keyId: row.id, appId: row.app_id, scope: row.scope }, at: now };
      this.#known.set(cacheKey, entry);
    }
    if (entry.auth.scope !== scope) return undefined;
    if (now - (this.#touched.get(entry.auth.keyId) ?? 0) > KEY_CACHE_MS) {
      this.#touched.set(entry.auth.keyId, now);
      void this.#db
        .query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [entry.auth.keyId])
        .catch(() => undefined);
    }
    return entry.auth;
  }

  /** Forgets cached results (after a key is revoked). */
  clear(): void {
    this.#known.clear();
    this.#unknown.clear();
  }
}

/** Ensures a plaintext key from the environment exists in `api_keys` (stored as its SHA-256 only). */
export async function seedKey(db: Db, appId: string, plaintext: string, label: string): Promise<void> {
  const scope = apiKeyScope(plaintext);
  if (!scope) throw new Error(`${label} is not a valid Shardlens key`);
  await db.query(
    `INSERT INTO api_keys (app_id, scope, sha256, label) VALUES ($1, $2, $3, $4) ON CONFLICT (sha256) DO NOTHING`,
    [appId, scope, sha256(plaintext), label],
  );
}

export async function createSession(db: Db, reply: FastifyReply, session: SessionAuth, secure: boolean): Promise<void> {
  const token = randomBytes(32).toString('base64url');
  await db.query('INSERT INTO sessions (id_sha256, user_id, app_id, method, expires_at) VALUES ($1, $2, $3, $4, $5)', [
    sha256(token),
    session.userId,
    session.appId,
    session.method,
    new Date(Date.now() + SESSION_TTL_MS),
  ]);
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export async function readSession(db: Db, req: FastifyRequest): Promise<SessionAuth | undefined> {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token || !/^[\w-]{43}$/.test(token)) return undefined;
  const res = await db.query<{ app_id: string; user_id: string | null; method: SessionAuth['method'] }>(
    'SELECT app_id, user_id, method FROM sessions WHERE id_sha256 = $1 AND expires_at > now()',
    [sha256(token)],
  );
  const row = res.rows[0];
  return row ? { appId: row.app_id, userId: row.user_id, method: row.method } : undefined;
}

export async function destroySession(db: Db, req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) await db.query('DELETE FROM sessions WHERE id_sha256 = $1', [sha256(token)]);
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}
