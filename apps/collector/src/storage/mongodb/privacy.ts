import type { PrivacyStorage } from '../store.js';
import type { Mongo } from './connect.js';
import { pending } from './pending.js';

export function mongoPrivacy(_m: Mongo): PrivacyStorage {
  return pending<PrivacyStorage>('privacy');
}
