/**
 * Gauge samples, each with the slot it fills. A shard is held by one process at a time, and a restarted process takes
 * over the shards its predecessor held, so for one minute after a restart two process IDs report for the same slot:
 * queries keep the newest per slot instead of adding both. A process-wide sample's slot is the set of shards its
 * process last reported holding; a process with no shards, or no health report, is a slot of its own.
 */
export function gaugeSamples(where: string): string {
  return `SELECT g.ts, g.name, g.shard, g.instance, g.value,
                 CASE WHEN g.shard >= 0 THEN 'shard ' || g.shard
                      WHEN cardinality(h.shards) > 0 THEN 'shards ' || array_to_string(h.shards, ',')
                      ELSE 'instance ' || g.instance END AS slot
            FROM gauges g LEFT JOIN sdk_health h ON h.app_id = g.app_id AND h.instance = g.instance
           WHERE ${where}`;
}
