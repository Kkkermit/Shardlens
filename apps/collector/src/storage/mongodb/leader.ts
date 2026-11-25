import { randomBytes } from 'node:crypto';
import type { JobLeader } from '../store.js';
import type { Mongo } from './connect.js';
import { isDuplicateKey } from './duplicate-key.js';

const LEASE_ID = 'jobs';

/**
 * Lease timing, chosen so two instances never lead at once whatever their hosts' clocks say:
 *
 * - Expiry is judged by the MongoDB server's clock (`$$NOW`) when a lease is taken or renewed, never by a host's: the
 *   clocks of bot hosts are often minutes apart, and they don't enter into it.
 * - The holder counts its lease down on its own monotonic clock from the moment it sent the renewal, which the server
 *   stamped later, so the holder's deadline always comes before the server's expiry. It stops leading `marginMs` before
 *   that deadline: room for clock drift, a late timer, and a failover to a replica set member whose clock is up to that
 *   much ahead. Lease writes wait for a majority, so a failover can't roll a renewal back.
 * - Renewing every 20 seconds keeps the leader's writes to three a minute; a leader that dies is replaced within about
 *   a minute and a half (the lease, then the others' next attempt, every 30 seconds).
 */
const TIMING = { leaseMs: 60_000, renewMs: 20_000, marginMs: 10_000 };

const majority = { writeConcern: { w: 'majority' as const } };

/**
 * A contender for job leadership, on a lease document in `shardlens_leases` (no advisory locks on MongoDB). The store
 * renews the lease itself while this contender leads. `timing` is for tests.
 */
export function mongoLeader({ c }: Mongo, timing = TIMING): JobLeader {
  const holder = randomBytes(12).toString('hex');
  let leading = false;
  let released = false;
  let onLost: (() => void) | undefined;
  let renewal: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;

  const stopTimers = () => {
    if (renewal) clearTimeout(renewal);
    if (deadline) clearTimeout(deadline);
    renewal = deadline = undefined;
  };

  const lost = () => {
    if (!leading) return;
    leading = false;
    stopTimers();
    onLost?.();
  };

  /** The lease is ours until `sentAt + leaseMs` by the server's clock: stop leading a margin before. */
  const heldSince = (sentAt: number) => {
    stopTimers();
    deadline = setTimeout(lost, Math.max(0, sentAt + timing.leaseMs - timing.marginMs - performance.now()));
    deadline.unref();
    renewal = setTimeout(() => void renew(), timing.renewMs);
    renewal.unref();
  };

  const renew = async () => {
    const sentAt = performance.now();
    try {
      const lease = await c.leases.findOneAndUpdate(
        { _id: LEASE_ID, holder },
        [{ $set: { expiresAt: { $add: ['$$NOW', timing.leaseMs] } } }],
        { returnDocument: 'after', ...majority },
      );
      if (!leading) return;
      if (lease) heldSince(sentAt);
      else lost();
    } catch {
      lost();
    }
  };

  return {
    async tryLead(lostCallback) {
      if (released) return false;
      onLost = lostCallback;
      const sentAt = performance.now();
      // Taken when nobody holds it, this contender does, or it has expired; otherwise left as it is. One document,
      // so the server decides atomically between contenders.
      const takeable = { $or: [{ $eq: ['$holder', holder] }, { $lt: ['$expiresAt', '$$NOW'] }] };
      let lease: { holder: string } | null;
      try {
        lease = await c.leases.findOneAndUpdate(
          { _id: LEASE_ID },
          [
            {
              $set: {
                holder: { $cond: [takeable, { $literal: holder }, '$holder'] },
                expiresAt: { $cond: [takeable, { $add: ['$$NOW', timing.leaseMs] }, '$expiresAt'] },
              },
            },
          ],
          { upsert: true, returnDocument: 'after', projection: { holder: 1 }, ...majority },
        );
      } catch (error) {
        // Two contenders created the lease at once, and the other one did.
        if (isDuplicateKey(error)) return false;
        throw error;
      }
      if (lease?.holder !== holder) return false;
      if (released) {
        await c.leases.deleteOne({ _id: LEASE_ID, holder }, majority).catch(() => undefined);
        return false;
      }
      leading = true;
      heldSince(sentAt);
      return true;
    },

    async release() {
      released = true;
      leading = false;
      stopTimers();
      await c.leases.deleteOne({ _id: LEASE_ID, holder }, majority).catch(() => undefined);
    },
  };
}
