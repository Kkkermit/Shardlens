import { type Db, insertRows } from '../../db.js';
import type { WebhookEventStorage } from '../store.js';
import { ENTITLEMENT_COLUMNS } from './ingest/write.js';

/** The `webhook.<type>` counters are rolled up from `webhook_events`. */
export function postgresWebhookEvents(db: Db): WebhookEventStorage {
  return {
    async record(d) {
      await insertRows(
        db,
        'webhook_events',
        ['id', 'ts', 'app_id', 'type', 'integration_type', 'user_hash', 'actor_enc', 'guild_id', 'scopes'],
        [[d.id, d.ts, d.appId, d.type, d.integrationType, d.userHash, d.actor, d.guildId, d.scopes]],
      );
    },

    async recordEntitlement(e) {
      await insertRows(db, 'entitlements', ENTITLEMENT_COLUMNS, [
        [
          e.appId,
          e.ts,
          e.action,
          e.skuId,
          e.entitlementType,
          e.owner,
          e.userHash,
          e.guildId,
          e.startsAt,
          e.endsAt,
          'webhook',
        ],
      ]);
    },
  };
}
