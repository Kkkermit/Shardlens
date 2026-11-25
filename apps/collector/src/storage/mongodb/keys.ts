import { Binary } from 'mongodb';
import type { ApiKeyListing, KeyStorage } from '../store.js';
import { mongoAdminAudit } from './admin-audit.js';
import type { Mongo } from './connect.js';
import { isDuplicateKey } from './duplicate-key.js';
import { compareIds, nextId } from './ids.js';

type NewKey = Parameters<KeyStorage['create']>[0];

export function mongoKeys(m: Mongo): KeyStorage {
  const { c } = m;
  const audit = mongoAdminAudit(m);

  /** Stores the key under the next ID, and returns the ID. */
  const insert = async (key: NewKey, sha256: Binary): Promise<string> => {
    const id = await nextId(c, 'api_keys');
    await c.apiKeys.insertOne({
      _id: id,
      appId: key.appId,
      scope: key.scope,
      sha256,
      label: key.label,
      createdAt: new Date(),
    });
    return id;
  };

  return {
    async findActive(sha256) {
      const key = await c.apiKeys.findOne(
        { sha256: new Binary(sha256), revokedAt: { $exists: false } },
        { projection: { appId: 1, scope: 1 } },
      );
      return key ? { id: key._id, appId: key.appId, scope: key.scope } : undefined;
    },

    async touch(id) {
      await c.apiKeys.updateOne({ _id: id }, { $set: { lastUsedAt: new Date() } });
    },

    async activeScopes(appId) {
      return c.apiKeys.distinct('scope', { appId, revokedAt: { $exists: false } });
    },

    async list(appId) {
      const keys = await c.apiKeys.find({ appId }, { projection: { sha256: 0 } }).toArray();
      // Newest first; a key made in the same millisecond as another sorts by its ID.
      keys.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || compareIds(b._id, a._id));
      return keys.map((k): ApiKeyListing => ({
        id: k._id,
        scope: k.scope,
        label: k.label ?? '',
        createdAt: k.createdAt,
        lastUsedAt: k.lastUsedAt ?? null,
        revokedAt: k.revokedAt ?? null,
      }));
    },

    create: (key) => insert(key, new Binary(key.sha256)),

    async revoke(appId, id) {
      const res = await c.apiKeys.updateOne(
        { _id: id, appId, revokedAt: { $exists: false } },
        { $set: { revokedAt: new Date() } },
      );
      return res.matchedCount > 0;
    },

    async ensureFromEnvironment(key) {
      const sha256 = new Binary(key.sha256);
      const found = await c.apiKeys.findOne({ sha256 }, { projection: { revokedAt: 1 } });
      if (found?.revokedAt) return;
      let id = found?._id;
      if (id === undefined) {
        try {
          id = await insert(key, sha256);
        } catch (error) {
          // Another collector stored the same value at the same moment, and replaces the older keys itself.
          if (isDuplicateKey(error)) return;
          throw error;
        }
      }
      const storedId = id;
      // Without a transaction, a start that stopped part-way leaves older keys unrevoked: a key still active does this
      // again, so the next start finishes it. Only keys stored before this one are touched, so an instance started with
      // an older value can't revoke a newer one.
      const others = await c.apiKeys
        .find(
          { appId: key.appId, scope: key.scope, label: key.label, revokedAt: { $exists: false } },
          { projection: { _id: 1 } },
        )
        .toArray();
      for (const { _id } of others.filter((k) => compareIds(k._id, storedId) < 0)) {
        const res = await c.apiKeys.updateOne(
          { _id, revokedAt: { $exists: false } },
          { $set: { revokedAt: new Date() } },
        );
        if (res.modifiedCount === 0) continue;
        await audit.record(key.appId, null, 'key_revoke', { id: _id, by: 'environment', variable: key.label });
        await c.sessions.deleteMany({ keyId: _id });
      }
    },
  };
}
