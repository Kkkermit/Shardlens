---
'@shardlens/core': minor
'@shardlens/discordjs': minor
---

Disk spool and member-count refresh. `spool: { dir }` keeps events on disk during long collector outages and across
restarts (NDJSON segments, 100 MB cap, oldest evicted first), replays them first when the collector is back and
deletes them only once accepted; spool files never contain user IDs or audit identities. `refreshGuildCounts: true`
refreshes approximate member counts one server every two seconds. Core gains the `EventSpool` interface.
