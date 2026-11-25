import type { LiveStorage } from '../store.js';
import type { Mongo } from './connect.js';
import { pending } from './pending.js';

export function mongoLive(_m: Mongo): LiveStorage {
  return pending<LiveStorage>('live');
}
