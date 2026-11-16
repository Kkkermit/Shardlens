import { randomBytes } from 'node:crypto';

type Scope = 'ingest' | 'read' | 'activity';

/** `slk_<scope>_` + 32 random bytes, base64url: the format the collector accepts. */
export function newKey(scope: Scope): string {
  return `slk_${scope}_${randomBytes(32).toString('base64url')}`;
}
