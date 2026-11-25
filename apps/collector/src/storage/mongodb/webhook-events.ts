import { Binary, UUID } from 'mongodb';
import type { WebhookEventStorage } from '../store.js';
import type { WebhookEventDoc } from './collections.js';
import type { Mongo } from './connect.js';
import { entitlementDoc } from './ingest/write.js';
import { compact, insertNew } from './writes.js';

/** The `webhook.<type>` counters are rolled up from `shardlens_webhook_events`. */
export function mongoWebhookEvents({ c }: Mongo): WebhookEventStorage {
  return {
    async record(d) {
      await insertNew(c.webhookEvents, [
        compact<WebhookEventDoc>({
          _id: new UUID(d.id),
          ts: d.ts,
          appId: d.appId,
          type: d.type,
          integrationType: d.integrationType,
          userHash: d.userHash && new Binary(d.userHash),
          actorEnc: d.actor && new Binary(d.actor),
          guildId: d.guildId,
          scopes: d.scopes,
        }),
      ]);
    },

    async recordEntitlement(e) {
      await insertNew(c.entitlements, [entitlementDoc({ ...e, source: 'webhook' })]);
    },
  };
}
