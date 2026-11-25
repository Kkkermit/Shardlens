import { Binary } from 'mongodb';
import type { SessionMethod, SessionStorage } from '../store.js';
import type { Mongo } from './connect.js';

export function mongoSessions({ c }: Mongo): SessionStorage {
  return {
    async create(session) {
      await c.sessions.insertOne({
        _id: new Binary(session.idSha256),
        ...(session.userId !== null && { userId: session.userId }),
        appId: session.appId,
        method: session.method,
        ...(session.keyId !== null && { keyId: session.keyId }),
        createdAt: new Date(),
        expiresAt: session.expiresAt,
      });
    },

    async find(idSha256) {
      // The TTL index removes expired sessions only about once a minute, so expiry is checked here too. Revoking a key
      // deletes its sessions; the key's own state also covers a session read while that runs. One round trip.
      const [session] = await c.sessions
        .aggregate<{ appId: string; userId?: string; method: SessionMethod; key: { revokedAt?: Date }[] }>([
          { $match: { _id: new Binary(idSha256), expiresAt: { $gt: new Date() } } },
          {
            $lookup: {
              from: c.apiKeys.collectionName,
              localField: 'keyId',
              foreignField: '_id',
              pipeline: [{ $project: { _id: 0, revokedAt: 1 } }],
              as: 'key',
            },
          },
        ])
        .toArray();
      if (!session || session.key.some((k) => k.revokedAt)) return undefined;
      return { appId: session.appId, userId: session.userId ?? null, method: session.method };
    },

    async delete(idSha256) {
      await c.sessions.deleteOne({ _id: new Binary(idSha256) });
    },

    async deleteForKey(keyId) {
      await c.sessions.deleteMany({ keyId });
    },
  };
}
