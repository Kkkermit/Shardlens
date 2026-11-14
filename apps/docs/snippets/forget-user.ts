import type { Shardlens } from '@shardlens/discordjs';

declare const lens: Shardlens;

// For example from your support tooling, after a verified erasure request.
export async function eraseUser(userId: string) {
  lens.optOut(userId); // stop collecting in this process (persist it with onOptOutChange)
  const result = await lens.forgetUser(userId); // never throws; undefined if the collector couldn't be reached
  return result?.erased ?? 0;
}
