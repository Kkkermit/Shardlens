# @shardlens/schema

## 1.1.0

### Minor Changes

- c220106: Record prefix (message) commands. `lens.wrapMessageCommand(name, handler)` and `lens.trackMessageCommand(message, run)`
  record a command your bot's parser matched in a message, such as `!ban @someone`, with its outcome, handler time and
  error class. The SDK reads the message's author, server, channel type and the author's permissions, and never its
  content. Prefix commands are stored with interactions as the `message_command` kind ("Prefix command" on the
  dashboard), so the Commands page, unique users, servers, funnels and the exporters count them. Deadline, response-time,
  Reliability and premium figures still cover interactions only.

  The wire format gains the additive `message_command` event; collectors older than this release drop it per event.
  `lens.wrap()` now runs a handler untouched when its first argument isn't an interaction, so one function can serve both
  slash and prefix commands.

- c220106: `parseBatch()` no longer throws on a server profile whose `botPermissions` is not a number: it drops that event, as
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

### Patch Changes

- c220106: The data-collected register no longer says the cluster ID is stored: the collector receives it with each batch and
  drops it.
- c220106: Fixes from adversarial testing of ingest and queries:

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

- c220106: Fixes from a simulated install on a discord.js 15 development build:

  - npm installs the adapter next to discord.js 15 development builds: the peer range is `^14.0.0 || ^15.0.0-0`.
  - A fatal gateway error on discord.js 15 (an invalid token on re-identify, say) crashes the bot as it does without
    Shardlens. The adapter's `error` listener on `client.ws` used to swallow it and leave the bot running, disconnected.
  - With `ShardingManager` on discord.js 15, whose `client.shard` has no `ids`, events are tagged with the process's
    shards again, and the startup work (server snapshot, application info, command list) runs.
  - After a fresh gateway session, the server snapshot comes from Discord's READY list instead of the cache, so servers
    removed while the shard was away are found (the cache keeps them), and on discord.js 15 servers added meanwhile too.
  - On discord.js 15, a shard's ready state no longer reports every server as unavailable.

- c220106: Hardening from a security review:

  - API and sign-in answers carry `Cache-Control: no-store` unless a route sets its own (public badges), so no browser
    or proxy cache keeps analytics, keys or, in audit mode, the decrypted activity log.
  - One visitor can hold at most 10 of the 100 live-update streams, so a single client (anyone, in demo mode) can't shut
    everyone else out of the live tiles.
  - The data-collected register says that team members' IDs are kept as they are, to check a Discord sign-in.

- c220106: Fixes from a full review of the SDK packages:

  - `shutdown()` sends events whose user hash was still being computed, instead of dropping them.
  - Numeric options that aren't numbers (`Number(process.env.UNSET)`) fall back to their defaults instead of throwing
    into the bot, stopping sends or running a 1 ms timer.
  - A rejected API key is reported as a rejected key even when its reply can't be read, and the "connected" log line
    follows a spool replay after an outage.
  - Opt-outs work with `disable: ['interactions']`, and an opted-out user's entitlements and subscriptions are dropped
    too, as the privacy docs say.
  - A REST window stays within the wire format's 2,000-row limit, so the collector no longer rejects it whole.
  - Bot processes sharing a spool folder can't replace each other's segments, and `spool.maxBytes` that isn't a number
    keeps the default cap.
  - `@shardlens/http`: unsubscribing an error listener added before the first event works.
  - `shardlens privacy --retention abc` fails instead of printing the default, and `doctor` no longer contradicts its own
    key check.

## 1.0.0

### Major Changes

- 75713a7: 1.0.0, the first stable release. From here a breaking change to a package's API, the CLI, the collector's HTTP API or
  its environment variables only comes in a new major version, with a migration note. The wire format keeps its own
  major version, which a collector accepts alongside the previous one.

### Minor Changes

- 680bb7c: First release: privacy-first analytics and health monitoring for discord.js bots. The SDK hashes user IDs in-process,
  batches events with retries and never throws into the bot; the discord.js adapter records interactions, REST health,
  servers, shards and premium events through public hooks only; the CLI sets up a self-hosted collector.
- 680bb7c: Scheduled reports: a daily or weekly summary (commands, unique users, failures, response time, servers, top commands)
  posted to a Discord channel through its webhook, set up on the new Reports page. Identified users (audit mode) now
  record exactly a user ID, a username and an avatar: `auditIncludeProfile` (default `true`) replaces
  `auditIncludeNames`, the display name is no longer collected, and the Activity log shows the avatar.
  `shardlens init --identify-users` creates the audit key, and `shardlens privacy --ids-only` replaces `--names`.

### Patch Changes

- 680bb7c: Funnels, a cohort builder and an Events page. Funnels count people who did 2–5 custom events or commands in order
  within a window; cohorts group people by when they started and show who came back. Steps are linked by salted hash
  inside the collector and only counts leave it. Interaction rollups no longer carry the server: per-server numbers come
  from the new `interactions.by_guild` metric, and migration 003 converts existing rollups.
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
