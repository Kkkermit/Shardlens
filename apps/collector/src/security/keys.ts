import { createHash, randomBytes } from 'node:crypto';

/**
 * `ingest` sends events, `read` runs queries, `activity` also reads who ran what in audit mode (for the owner's own
 * dashboard, where no person signs in with Discord).
 */
export type ApiKeyScope = 'ingest' | 'read' | 'activity';

/**
 * Creates an API key: `slk_<scope>_<32 random bytes, base64url>`. The plaintext is shown once; only its SHA-256 is
 * stored.
 */
export function newApiKey(scope: ApiKeyScope): { plaintext: string; sha256: string } {
  const plaintext = `slk_${scope}_${randomBytes(32).toString('base64url')}`;
  return { plaintext, sha256: createHash('sha256').update(plaintext).digest('hex') };
}

/** Scope encoded in a key's prefix, or `undefined` if the key is not a Shardlens key. */
export function apiKeyScope(presented: string): ApiKeyScope | undefined {
  const match = /^slk_(ingest|read|activity)_[\w-]{43}$/.exec(presented);
  return match?.[1] as ApiKeyScope | undefined;
}
