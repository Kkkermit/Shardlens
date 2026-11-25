import type { DemoStorage } from '../store.js';
import type { Mongo } from './connect.js';
import { pending } from './pending.js';

export function mongoDemo(_m: Mongo): DemoStorage {
  return pending<DemoStorage>('demo');
}
