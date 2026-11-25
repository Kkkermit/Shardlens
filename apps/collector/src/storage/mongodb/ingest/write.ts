import type { IngestStorage } from '../../store.js';
import type { Mongo } from './../connect.js';
import { pending } from './../pending.js';

export function mongoIngest(_m: Mongo): IngestStorage {
  return pending<IngestStorage>('ingest');
}
