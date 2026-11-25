import type { WebhookEventStorage } from '../store.js';
import type { Mongo } from './connect.js';
import { pending } from './pending.js';

export function mongoWebhookEvents(_m: Mongo): WebhookEventStorage {
  return pending<WebhookEventStorage>('webhookEvents');
}
