import type { SessionStorage } from '../store.js';
import type { Mongo } from './connect.js';
import { pending } from './pending.js';

export function mongoSessions(_m: Mongo): SessionStorage {
  return pending<SessionStorage>('sessions');
}
