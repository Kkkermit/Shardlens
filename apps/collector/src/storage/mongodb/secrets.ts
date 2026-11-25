import { randomBytes } from 'node:crypto';
import { seedKey } from '../../security/auth.js';
import type { Store } from '../store.js';
import type { Collections, SecretDoc } from './collections.js';

/**
 * The label of the keys generated for an app on MongoDB. Keys from the environment have their variable's name, and a
 * new one revokes only older keys with that name, so the collector image's keys and the bot's never revoke each other.
 */
const GENERATED = 'generated';

const newKey = (scope: string) => `slk_${scope}_${randomBytes(32).toString('base64url')}`;

/**
 * The app's secrets and keys, generated on its first start and shared from then on by every process on the database:
 * each process of the bot, `npx shardlens dashboard` and the collector image. Created atomically, so processes that
 * start together all get the first one's.
 */
export async function appSecrets(c: Collections, appId: string): Promise<SecretDoc> {
  const fresh: Omit<SecretDoc, '_id'> = {
    sessionSecret: randomBytes(48).toString('base64url'),
    settingsKey: randomBytes(32).toString('base64'),
    ingestKey: newKey('ingest'),
    readKey: newKey('read'),
    activityKey: newKey('activity'),
    createdAt: new Date(),
  };
  const doc = await c.secrets.findOneAndUpdate(
    { _id: `app:${appId}` },
    { $setOnInsert: fresh },
    { upsert: true, returnDocument: 'after' },
  );
  if (!doc) throw new Error('MongoDB returned no secrets document');
  return doc;
}

/** Registers the app, and stores the hashes of its generated keys (once: later calls change nothing). */
export async function seedGeneratedKeys(store: Store, appId: string, secrets: SecretDoc): Promise<void> {
  await store.apps.register(appId);
  for (const key of [secrets.ingestKey, secrets.readKey, secrets.activityKey]) {
    await seedKey(store, appId, key, GENERATED);
  }
}

/** The app whose collector has run on this database, when there is exactly one. */
export async function onlyApp(c: Collections): Promise<string> {
  const apps = await c.secrets
    .find({ _id: { $regex: /^app:\d+$/ } }, { projection: { _id: 1 } })
    .limit(2)
    .toArray();
  const only = apps.length === 1 ? apps[0]?._id.slice('app:'.length) : undefined;
  if (only) return only;
  throw new Error(
    apps.length === 0
      ? 'Shardlens has no data in this database yet: start your bot with the mongodb option first, or give the application ID.'
      : 'Several bots keep their Shardlens data in this database: give the application ID of the one to show.',
  );
}
