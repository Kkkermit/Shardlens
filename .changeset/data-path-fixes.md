---
'@shardlens/collector': patch
'@shardlens/schema': patch
---

Fixes from adversarial testing of ingest and queries:

- One event the database refuses (a number wider than its column) no longer costs the rest of its batch: the batch is
  written event by event and only that event is rejected (`refused_by_database`). Text cut through an emoji is
  repaired instead of refused.
- A batch retried by a bot whose clock is minutes off is stored once, not twice.
- A command list naming one command twice, and two people buying the same SKU in the same millisecond, are stored
  correctly; retried entitlements, subscriptions, shard states and permission changes count as duplicates.
- Late server outages, entitlements and subscriptions reach the rollups.
- Finishing a new shard layout no longer undoes the joins and leaves recorded since each shard's snapshot, and a
  snapshot of a shard outside the layout is ignored.
- Saving one Settings section no longer resets the time zone to UTC. Every IANA time-zone name is accepted
  (`Asia/Kolkata` as well as `Asia/Calcutta`), and Settings checks PostgreSQL knows it.
- In a time zone half an hour off UTC, hourly charts show each hour at its real start (10:30) instead of under the
  hour before; days older than 13 months keep their UTC date; the heatmap reads hourly data only.
- A command whose name has a dot opens on reload or from a link; required permission bits over 63 bits are refused,
  and the Servers filter works with any server's bits. Histogram buckets and rate-limit waits are bounded.
