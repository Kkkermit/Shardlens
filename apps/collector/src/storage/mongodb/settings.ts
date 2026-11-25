import type { SettingStorage } from '../store.js';
import type { Mongo } from './connect.js';
import { pending } from './pending.js';

export function mongoSettings(_m: Mongo): SettingStorage {
  return pending<SettingStorage>('settings');
}
