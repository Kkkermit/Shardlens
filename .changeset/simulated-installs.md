---
'@shardlens/collector': patch
'@shardlens/discordjs': patch
'@shardlens/http': patch
'@shardlens/core': patch
'@shardlens/schema': patch
'@shardlens/exporter-prometheus': patch
'shardlens': patch
---

Fixes found by installing and running Shardlens end to end against simulated bots.

SDK: a reply Discord refused as too late is a missed deadline even when the handler then throws; a command that opens
a modal records the modal's ID; `track()` stamps an event when it is called; nothing is lost when the collector
leaves audit mode; `/privacy erase` no longer leaves its own interaction behind; a server is reported available again
only after an outage; the Prometheus exporter counts handler errors and no longer reports a gauge it has no value for
as 0. The server owner's ID is no longer collected, in any mode.

Collector: missed deadlines include interactions that got no reply; a range that starts mid-hour is read from the
start of the hour, and a range ending now includes today's unique users; a dimension a metric doesn't keep is refused
with a message listing the ones it does; memory, caches and servers per shard add up across the processes of a
sharded bot; `429` answers `rate_limited` and a body that isn't gzip answers `400`; the activity log refuses filters
it doesn't know; a missing dashboard file is a 404; five-minute jobs run every five minutes; SDK health rows of
processes that stopped expire after 30 days.

CLI: `shardlens --help` works, `doctor` passes for `@shardlens/http` bots, and the generated compose file no longer
mentions `.env.example`.
