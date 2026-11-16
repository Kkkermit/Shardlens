import { ShardlensClientError } from './errors.js';
import type { TimeRange } from './specs.js';

/** The last `days` days up to now, as a query's `range`. */
export function lastDays(days: number): TimeRange {
  if (!(days > 0) || !Number.isFinite(days)) {
    throw new ShardlensClientError('lastDays needs a positive number of days', { status: 0, code: 'invalid_options' });
  }
  const to = Date.now();
  return { from: new Date(to - days * 86_400_000).toISOString(), to: new Date(to).toISOString() };
}
