import type pg from 'pg';
import type { Db } from '../../db.js';
import type { JobLeader } from '../store.js';

/** Advisory lock key for the single job leader (any constant; shared by every collector). */
const LEADER_LOCK = 727_274_001;

/**
 * Leadership is a session advisory lock on a connection of its own. If the leader dies, its session ends, the lock is
 * released and another collector takes it at its next attempt. One connection is kept, with one error listener, while
 * another collector leads.
 */
export function postgresLeader(db: Db): JobLeader {
  let lockClient: pg.PoolClient | undefined;
  let released = false;
  let onLost: (() => void) | undefined;

  // A broken connection goes back to the pool to be destroyed: until then it holds a pool slot.
  const dropLock = (client: pg.PoolClient) => {
    if (lockClient !== client) return;
    lockClient = undefined;
    onLost?.();
    client.release(true);
  };

  return {
    async tryLead(lost) {
      onLost = lost;
      try {
        if (!lockClient) {
          const client = await db.connect();
          if (released) {
            client.release();
            return false;
          }
          // The lock lives and dies with this connection's session.
          client.on('error', () => dropLock(client));
          lockClient = client;
        }
        const res = await lockClient.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [LEADER_LOCK]);
        return Boolean(res.rows[0]?.ok);
      } catch (error) {
        if (lockClient) dropLock(lockClient);
        throw error;
      }
    },

    async release() {
      released = true;
      const client = lockClient;
      if (!client) return;
      await client.query('SELECT pg_advisory_unlock($1)', [LEADER_LOCK]).catch(() => undefined);
      if (lockClient === client) {
        lockClient = undefined;
        client.release();
      }
    },
  };
}
