import type { GuildName } from '../storage/store.js';

/** Adds each server's name and icon to rows keyed by server ID (`null` for an ID with no profile, or a non-ID key). */
export async function withGuildNames<T extends { key: string }>(
  lookup: (appId: string, ids: string[]) => Promise<GuildName[]>,
  appId: string,
  rows: T[],
): Promise<(T & { name: string | null; icon: string | null })[]> {
  const ids = rows.map((r) => r.key).filter((k) => /^\d{17,20}$/.test(k));
  if (ids.length === 0) return rows.map((r) => ({ ...r, name: null, icon: null }));
  const byId = new Map((await lookup(appId, ids)).map((n) => [n.id, n]));
  return rows.map((r) => ({ ...r, name: byId.get(r.key)?.name ?? null, icon: byId.get(r.key)?.icon ?? null }));
}
