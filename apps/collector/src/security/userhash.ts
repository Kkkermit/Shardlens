import { createHmac } from 'node:crypto';
import type { Db, Tx } from '../db.js';
import { ensureSalt } from '../storage/maintenance.js';
import { periodLabel, type SaltPeriod } from '../storage/periods.js';

/**
 * The collector's half of user pseudonymisation, for data that reaches it directly from Discord (webhook events).
 * Same algorithm as the SDK (`HMAC-SHA-256(period salt, userId)`, first 16 bytes), so a user who installs the app and
 * later runs a command has the same hash in both places within a salt period. Raw IDs are never stored.
 */
export function hmacUser(secret: Buffer, userId: string): Buffer {
  return createHmac('sha256', secret).update(userId).digest().subarray(0, 16);
}

/** Hash for the salt period containing `at`, or `undefined` if that period's salt is gone (destroyed or never made). */
export async function hashUserId(
  db: Db | Tx,
  appId: string,
  userId: string,
  at: Date = new Date(),
): Promise<{ period: string; bytes: Buffer } | undefined> {
  const app = await db.query<{ salt_period: SaltPeriod }>('SELECT salt_period FROM apps WHERE app_id = $1', [appId]);
  const saltPeriod = app.rows[0]?.salt_period ?? 'month';
  const period = periodLabel(saltPeriod, at);
  // Salts are created lazily; make sure the *current* period has one (never create salts for past periods).
  if (period === periodLabel(saltPeriod, new Date())) await ensureSalt(db, appId, period);
  const salt = await db.query<{ secret: Buffer | null }>(
    'SELECT secret FROM salts WHERE app_id = $1 AND period = $2 AND destroy_after > now()',
    [appId, period],
  );
  const secret = salt.rows[0]?.secret;
  return secret ? { period, bytes: hmacUser(secret, userId) } : undefined;
}
