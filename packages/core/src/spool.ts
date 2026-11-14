import type { WireEvent } from './client.js';

/**
 * Durable overflow storage for long collector outages. The client writes batches when memory fills up and on
 * `shutdown()`, replays the oldest first, and acknowledges a batch only once the collector accepted it. Batches never
 * contain raw user IDs. Implementations may throw; the client catches and counts every failure.
 */
export interface EventSpool {
  /** Persists a batch. Resolves `false` when it can't be stored (for example the size cap is reached). */
  write(events: readonly WireEvent[]): Promise<boolean>;
  /** The oldest stored batch, or `undefined` when the spool is empty. */
  next(): Promise<{ id: string; events: WireEvent[] } | undefined>;
  ack(id: string): Promise<void>;
}
