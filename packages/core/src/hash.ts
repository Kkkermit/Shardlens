const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

/** How long one salt lives. Shorter periods are stricter but cannot produce weekly or monthly unique users. */
export type SaltPeriod = 'day' | 'week' | 'month';

/** Period label, always in UTC: `2026-11` (month), `2026-W46` (ISO week) or `2026-11-13` (day). */
export function periodLabel(period: SaltPeriod, at: Date = new Date()): string {
  const y = at.getUTCFullYear();
  const m = String(at.getUTCMonth() + 1).padStart(2, '0');
  if (period === 'month') return `${y}-${m}`;
  if (period === 'day') return `${y}-${m}-${String(at.getUTCDate()).padStart(2, '0')}`;
  // ISO week: weeks start on Monday; week 1 contains the year's first Thursday.
  const d = new Date(Date.UTC(y, at.getUTCMonth(), at.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const isoYear = d.getUTCFullYear();
  const week = Math.ceil(((d.getTime() - Date.UTC(isoYear, 0, 1)) / 86_400_000 + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

export const HASH_VERSION = 'h1';

export const HASH_BYTES = 16;

/** The previous period, the current one and, in its last minutes, the next, which the SDK fetches before it starts. */
const MAX_KEYS = 3;

/** Recently computed hashes kept in memory. Active users repeat, so most interactions skip the HMAC. */
const CACHE_SIZE = 20_000;

/**
 * Pseudonymises Discord user IDs inside the bot process: `HMAC-SHA-256(period salt, userId)`, truncated to 16 bytes
 * and formatted as `h1:<period>:<32 hex>`. Keyed, because snowflakes are guessable and a plain hash could be reversed.
 */
export class UserHasher {
  #keys = new Map<string, CryptoKey>();
  /** `label\0userId` → hash. Cleared whenever the set of salts changes, so no hash outlives its salt. */
  #cache = new Map<string, string>();

  /** Installs a period's salt (32 bytes). Only the three most recently added periods are kept. */
  async setSalt(label: string, salt: Uint8Array): Promise<void> {
    const key = await crypto.subtle.importKey(
      'raw',
      salt as Uint8Array<ArrayBuffer>,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    this.#keys.delete(label);
    this.#keys.set(label, key);
    while (this.#keys.size > MAX_KEYS) this.#keys.delete(this.#keys.keys().next().value!);
    this.#cache.clear();
  }

  /** Removes a period's salt, such as one the collector has destroyed, and every hash computed with it. */
  deleteSalt(label: string): void {
    if (this.#keys.delete(label)) this.#cache.clear();
  }

  labels(): string[] {
    return [...this.#keys.keys()];
  }

  hasSalt(label: string): boolean {
    return this.#keys.has(label);
  }

  /** The user hash, or `undefined` when no salt is installed for the period. */
  async hash(userId: string, label: string): Promise<string | undefined> {
    const key = this.#keys.get(label);
    if (!key) return undefined;
    const cacheKey = `${label}\0${userId}`;
    const cached = this.#cache.get(cacheKey);
    if (cached !== undefined) return cached;
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(userId)));
    let hex = '';
    for (const x of mac.subarray(0, HASH_BYTES)) hex += HEX[x];
    const hash = `${HASH_VERSION}:${label}:${hex}`;
    // A salt may have been replaced while the HMAC ran; only cache hashes for keys still installed.
    if (this.#keys.get(label) === key) {
      if (this.#cache.size >= CACHE_SIZE) this.#cache.delete(this.#cache.keys().next().value!);
      this.#cache.set(cacheKey, hash);
    }
    return hash;
  }
}
