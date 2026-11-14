# @shardlens/collector

## 1.0.0

### Major Changes

- 75713a7: 1.0.0, the first stable release. From here a breaking change to a package's API, the CLI, the collector's HTTP API or
  its environment variables only comes in a new major version, with a migration note. The wire format keeps its own
  major version, which a collector accepts alongside the previous one.

### Minor Changes

- 680bb7c: ClickHouse analytics store (preview). With `CLICKHOUSE_URL` set, ingest also mirrors accepted interactions and custom
  events into ClickHouse (MergeTree raw tables with a 35-day TTL, AggregatingMergeTree minute rollups), and series, top
  and heatmap queries for them are answered from ClickHouse for ranges it covers. PostgreSQL stays the system of
  record; erasure covers both.
- 680bb7c: Embedded mode: `startEmbeddedCollector({ dataDir, appId })` from `@shardlens/collector/embedded` runs the collector,
  its jobs and the dashboard inside your bot process on an in-process PostgreSQL (PGlite, an optional peer
  dependency), with the same SQL as the standalone collector. The collector is now published to npm for this.
- 680bb7c: First release: privacy-first analytics and health monitoring for discord.js bots. The SDK hashes user IDs in-process,
  batches events with retries and never throws into the bot; the discord.js adapter records interactions, REST health,
  servers, shards and premium events through public hooks only; the CLI sets up a self-hosted collector.
- 680bb7c: Funnels, a cohort builder and an Events page. Funnels count people who did 2–5 custom events or commands in order
  within a window; cohorts group people by when they started and show who came back. Steps are linked by salted hash
  inside the collector and only counts leave it. Interaction rollups no longer carry the server: per-server numbers come
  from the new `interactions.by_guild` metric, and migration 003 converts existing rollups.
- 680bb7c: Scheduled reports: a daily or weekly summary (commands, unique users, failures, response time, servers, top commands)
  posted to a Discord channel through its webhook, set up on the new Reports page. Identified users (audit mode) now
  record exactly a user ID, a username and an avatar: `auditIncludeProfile` (default `true`) replaces
  `auditIncludeNames`, the display name is no longer collected, and the Activity log shows the avatar.
  `shardlens init --identify-users` creates the audit key, and `shardlens privacy --ids-only` replaces `--names`.

### Patch Changes

- fd04dff: New Shardlens logo in the dashboard: an aperture of six shards, which replaces the line-chart mark.
- 680bb7c: The command page shows which types of channel a command is run in (text channels, threads, forums, voice chat). The
  type was already collected; channel IDs and names still never are.
- 680bb7c: Clearer logs. The SDK says once when it can't reach the collector (and once when it is back) instead of only counting
  the failure. The collector logs a startup summary, rejected events with their reasons, failed Discord sign-ins and
  failed live updates, includes a `requestId` in `500` replies that matches its log line, and records an alert whose
  webhook can no longer be decrypted in that alert's history.
- 680bb7c: Hardening before the first release. The collector rate limits every route per client address (unknown paths
  included), checks the ingest key before reading the request body, keeps real keys cached through floods of made-up
  ones, and runs its own forward-only migration runner on PostgreSQL and in embedded mode. `shardlens doctor` now
  detects discord.js 15. Core exports the small helpers the adapters share (`errorClass`, `errorCode`, `compact`,
  `DEFAULT_DURATION_BUCKETS`).
- 680bb7c: Input hardening from a security pass. Strings containing a NUL character and IDs too large for a 64-bit integer are
  now refused as invalid (per event on ingest) instead of failing the request, and anything else the database refuses
  is answered with 400 rather than 500, so an SDK never retries a poison batch forever. Requests must arrive within 30
  seconds, a client that disconnects early no longer produces an error, command names in reports can't add lines or
  formatting, the dashboard has a page-not-found view, and wide tables no longer widen the page on a phone.
- 680bb7c: Fixes found by installing and running Shardlens end to end against simulated bots.

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

- Updated dependencies [680bb7c]
- Updated dependencies [680bb7c]
- Updated dependencies [680bb7c]
- Updated dependencies [680bb7c]
- Updated dependencies [680bb7c]
- Updated dependencies [680bb7c]
- Updated dependencies [680bb7c]
- Updated dependencies [680bb7c]
- Updated dependencies [680bb7c]
- Updated dependencies [680bb7c]
- Updated dependencies [75713a7]
  - @shardlens/core@1.0.0
  - @shardlens/schema@1.0.0
