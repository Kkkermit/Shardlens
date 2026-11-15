---
'@shardlens/schema': minor
---

`parseBatch()` no longer throws on a server profile whose `botPermissions` is not a number: it drops that event, as
it does any invalid one. Before, the collector answered the whole batch with a 500 and the SDK retried it forever.

The published JSON Schema (`batch.schema.json`) now states every rule `parseBatch()` applies: no `actor` in a
privacy-mode batch, no NUL characters, and permission bitfields of at most 64 bits. `batchJsonSchema()` returns it.

New `MAX_EVENT_WEIGHT` (10,000). `ConfigResponse` sample rates are at least 1 / `MAX_EVENT_WEIGHT`: below that, every
event kept by sampling carried a weight the collector refused.

The data-collected register now matches what the collector stores. Rate-limit `limit` and `sublimitTimeout`, the REST
window length, the invalid-request window's remaining time, a shard's unavailable servers at startup and the shard of
a server outage are marked as not stored. Shard events, command permission changes, server joins, removals and
outages, entitlements and subscriptions are kept with no automatic expiry, under the new `history` retention. Gauges
are kept 30 days with no hourly aggregates after that. The metric registry gains the `rest.invalid_warning_count`
gauge, and says that `shard.events` and `commands.permissions` are not summed into rollups.
