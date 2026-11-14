const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

/** Random bytes are drawn from the CSPRNG in blocks, so each ID doesn't pay for a separate call. */
const POOL_SIZE = 4096;
const pool = new Uint8Array(POOL_SIZE);
let poolOffset = POOL_SIZE;

/**
 * RFC 9562 UUIDv7. Event IDs sort by time, so the collector can drop retried duplicates with a primary-key conflict
 * that stays inside one time partition.
 */
export function uuidv7(now: number = Date.now()): string {
  const b = new Uint8Array(16);
  if (poolOffset + 10 > POOL_SIZE) {
    crypto.getRandomValues(pool);
    poolOffset = 0;
  }
  b.set(pool.subarray(poolOffset, poolOffset + 10), 6);
  poolOffset += 10;
  let ts = Math.max(0, Math.floor(now));
  for (let i = 5; i >= 0; i--) {
    b[i] = ts % 256;
    ts = Math.floor(ts / 256);
  }
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  let h = '';
  for (const x of b) h += HEX[x];
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function uuidv7Timestamp(id: string): number {
  return Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
}
