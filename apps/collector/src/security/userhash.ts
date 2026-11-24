import { createHmac } from 'node:crypto';
import { periodLabel } from '../storage/periods.js';
import { ensureSalt } from '../storage/salts.js';
import type { Store } from '../storage/store.js';

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
  store: Store,
  appId: string,
  userId: string,
  at: Date = new Date(),
): Promise<{ period: string; bytes: Buffer } | undefined> {
  const saltPeriod = (await store.apps.get(appId))?.saltPeriod ?? 'month';
  const period = periodLabel(saltPeriod, at);
  // Salts are created lazily; make sure the *current* period has one (never create salts for past periods).
  if (period === periodLabel(saltPeriod, new Date())) await ensureSalt(store, appId, period);
  const secret = await store.salts.secret(appId, period);
  return secret ? { period, bytes: hmacUser(secret, userId) } : undefined;
}
