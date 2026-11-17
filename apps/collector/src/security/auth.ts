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
  readonly #db: Db;
  readonly #known = new Map<string, { auth: KeyAuth; at: number }>();
  readonly #unknown = new Map<string, number>();
  readonly #touched = new Map<string, number>();

  constructor(db: Db) {
    this.#db = db;
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
    if (!allowed.includes(entry.auth.scope)) return undefined;
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

/**
 * Ensures a plaintext key from the environment exists in `api_keys` (stored as its SHA-256 only), labelled with its
 * variable. A new value revokes the key the variable held before: without the dashboard, changing the variable is the
 * only way to replace a leaked key. Only a key seen for the first time does this, so a collector instance still
 * started with the old value can't revoke the new one.
 */
export async function seedKey(db: Db, appId: string, plaintext: string, label: string): Promise<void> {
  const scope = apiKeyScope(plaintext);
  if (!scope) throw new Error(`${label} is not a valid Shardlens key`);
  const digest = sha256(plaintext);
  await db.query(
    `WITH added AS (
       INSERT INTO api_keys (app_id, scope, sha256, label) VALUES ($1, $2, $3, $4)
       ON CONFLICT (sha256) DO NOTHING RETURNING id
     ), replaced AS (
       UPDATE api_keys SET revoked_at = now()
        WHERE EXISTS (SELECT 1 FROM added) AND app_id = $1 AND scope = $2 AND label = $4 AND sha256 <> $3
          AND revoked_at IS NULL
       RETURNING id
     ), signed_out AS (
       DELETE FROM sessions WHERE key_id IN (SELECT id FROM replaced)
     )
     INSERT INTO admin_audit (app_id, action, details)
     SELECT $1, 'key_revoke', jsonb_build_object('id', id::text, 'by', 'environment', 'variable', $4::text)
       FROM replaced`,
    [appId, scope, digest, label],
  );
}

export async function createSession(db: Db, reply: FastifyReply, session: SessionAuth, secure: boolean): Promise<void> {
  const token = randomBytes(32).toString('base64url');
  await db.query(
    'INSERT INTO sessions (id_sha256, user_id, app_id, method, key_id, expires_at) VALUES ($1, $2, $3, $4, $5, $6)',
    [
      sha256(token),
      session.userId,
      session.appId,
      session.method,
      session.keyId ?? null,
      new Date(Date.now() + SESSION_TTL_MS),
    ],
  );
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
  // Revoking a key deletes its sessions; the join also covers a session read while that runs.
  const res = await db.query<{ app_id: string; user_id: string | null; method: SessionAuth['method'] }>(
    `SELECT s.app_id, s.user_id, s.method FROM sessions s LEFT JOIN api_keys k ON k.id = s.key_id
      WHERE s.id_sha256 = $1 AND s.expires_at > now() AND (s.key_id IS NULL OR k.revoked_at IS NULL)`,
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
