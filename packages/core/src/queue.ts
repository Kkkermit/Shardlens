/**
 * Drop priority for queued events. When the queue is full, lower lanes are evicted first:
 * `0` gauges, `1` REST windows and guild updates, `2` custom events, rate limits and app info,
 * `3` interactions and server lifecycle (dropped last).
 */
export type Priority = 0 | 1 | 2 | 3;

export const PRIORITIES = 4;

export interface QueuedItem<T> {
  item: T;
  priority: Priority;
}

/**
 * A bounded, priority-aware FIFO. It never grows past `capacity`: when full, it evicts the oldest item from the lowest
 * non-empty lane at or below the new item's priority, or refuses the new item if only higher-priority items remain.
 * Every eviction and refusal is counted in {@link BoundedQueue.dropped}, per lane.
 */
export class BoundedQueue<T> {
  readonly #lanes: T[][] = [[], [], [], []];
  #size = 0;
  /** Per priority. */
  readonly dropped: number[] = [0, 0, 0, 0];
  readonly capacity: number;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('capacity must be a positive integer');
    this.capacity = capacity;
  }

  get size(): number {
    return this.#size;
  }

  laneSize(priority: Priority): number {
    return this.#lanes[priority]!.length;
  }

  /** Lowest non-empty lane whose priority is at or below `max`. */
  #evictable(max: Priority): number {
    for (let p = 0; p <= max; p++) if (this.#lanes[p]!.length > 0) return p;
    return -1;
  }

  push(item: T, priority: Priority): void {
    if (this.#size >= this.capacity) {
      const lane = this.#evictable(priority);
      if (lane === -1) {
        this.dropped[priority]!++;
        return;
      }
      this.#lanes[lane]!.shift();
      this.dropped[lane]!++;
      this.#size--;
    }
    this.#lanes[priority]!.push(item);
    this.#size++;
  }

  /** Highest priority first, oldest first within a lane. */
  take(n: number): QueuedItem<T>[] {
    const out: QueuedItem<T>[] = [];
    for (let p = PRIORITIES - 1; p >= 0 && out.length < n; p--) {
      const lane = this.#lanes[p]!;
      const k = Math.min(n - out.length, lane.length);
      for (const item of lane.splice(0, k)) out.push({ item, priority: p as Priority });
    }
    this.#size -= out.length;
    return out;
  }

  /**
   * Puts a failed batch back at the front of its lanes. If the queue filled up meanwhile, the eviction rule applies:
   * lower lanes give way, and within a lane the batch's oldest items are dropped first. One splice per lane, so a large
   * queue doesn't pay for every item on every retry.
   */
  requeue(items: readonly QueuedItem<T>[]): void {
    const byLane: T[][] = [[], [], [], []];
    for (const { item, priority } of items) byLane[priority]!.push(item);
    for (let p = PRIORITIES - 1; p >= 0; p--) {
      const group = byLane[p]!;
      if (group.length === 0) continue;
      let room = this.capacity - this.#size;
      for (let lower = 0; lower < p && room < group.length; lower++) {
        const lane = this.#lanes[lower]!;
        const evicted = Math.min(lane.length, group.length - room);
        if (evicted === 0) continue;
        lane.splice(0, evicted);
        this.dropped[lower]! += evicted;
        this.#size -= evicted;
        room += evicted;
      }
      const kept = room >= group.length ? group : group.slice(group.length - Math.max(0, room));
      this.dropped[p]! += group.length - kept.length;
      this.#lanes[p] = kept.concat(this.#lanes[p]!);
      this.#size += kept.length;
    }
  }

  /** Removes every queued item `match` accepts (a user's events, when they ask for erasure). Returns how many. */
  removeWhere(match: (item: T) => boolean): number {
    let removed = 0;
    for (let p = 0; p < PRIORITIES; p++) {
      const lane = this.#lanes[p]!;
      const keep = lane.filter((item) => !match(item));
      removed += lane.length - keep.length;
      this.#lanes[p] = keep;
    }
    this.#size -= removed;
    return removed;
  }
}
