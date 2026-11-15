# @shardlens/core

## 1.1.0

### Minor Changes

- c220106: Fixes found by soak-testing the client against a collector that flaps, hangs, rate limits with odd `Retry-After`
  values, rejects events and sends broken replies, across salt-period boundaries and clock steps:

  - No user events are lost when a salt period starts. The SDK asks for the next period's salt 1 to 4 minutes before the
    boundary, while the collector serves it; before, it asked just after, so a busy bot dropped user events at every
    boundary (daily with a `day` salt period) while they waited for the salt.
  - After a clock step, or a machine waking from sleep, into a period the SDK has no salt for, it asks for one within
    seconds instead of at the next hourly refresh, dropping user events until then.
  - The SDK holds only the salts the collector serves, so a salt destroyed there no longer stays in the bot's memory, and
    an erasure names only live periods. New: `UserHasher.deleteSalt()`.
  - During an outage, events go to the spool in full batches rather than one or two at a time, so the spool replays in a
    few requests instead of thousands once the collector is back. While a request hangs, events go to the spool before
    memory fills up; before, they were dropped from memory until the request timed out.
  - `stats().dropped` accounts for every event. Rejections in a replayed spool batch, which were counted as replayed, and
    in a `202` reply are counted once each, never the health event; so are events whose builder throws, and user events
    still waiting for a salt at shutdown, whose raw IDs are then released.
  - A spooled batch that can't be sent (not a list, or holding `null`) is dropped instead of blocking every later send. A
    spooled batch answered with `413` is split in two and tried again, as batches from memory already were, instead of
    being dropped whole. A dry run never sends events spooled by an earlier run.
  - A client that can't send (no `apiKey`, or an endpoint that isn't allowed) queues nothing instead of holding up to
    `maxQueueSize` events.
  - `flush()` after `shutdown()` sends nothing, and a request given up at the end of shutdown is not reported as an
    outage. While the collector flaps, "can't reach the collector" is logged at most every 5 minutes.
  - `cutText()` and `sanitiseCustomProps()` replace NUL, which the collector refuses, and the source instance goes
    through `cutText()`, so a NUL can't get a whole batch refused. A `source()` that returns something other than an
    object falls back to the default instead of dropping every batch.
  - A sample rate below 1/10,000 is used as 1/10,000, the lowest whose weight the collector accepts; lower rates lost
    every event they kept.
  - `translateEvent()` skips REST rows and gauges that aren't objects instead of throwing.
  - Each batch is serialised once instead of twice. Published files no longer point at source maps the package leaves
    out. An empty `environment` no longer warns.

- c220106: Record prefix (message) commands. `lens.wrapMessageCommand(name, handler)` and `lens.trackMessageCommand(message, run)`
  record a command your bot's parser matched in a message, such as `!ban @someone`, with its outcome, handler time and
  error class. The SDK reads the message's author, server, channel type and the author's permissions, and never its
  content. Prefix commands are stored with interactions as the `message_command` kind ("Prefix command" on the
  dashboard), so the Commands page, unique users, servers, funnels and the exporters count them. Deadline, response-time,
  Reliability and premium figures still cover interactions only.

  The wire format gains the additive `message_command` event; collectors older than this release drop it per event.
  `lens.wrap()` now runs a handler untouched when its first argument isn't an interaction, so one function can serve both
  slash and prefix commands.

### Patch Changes

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

- c220106: Fixes from chaos-testing the SDKs against a hostile collector, bad options and real discord.js clients:

  - Options of the wrong type (a number `environment` or `release`, an exporter passed without the array, an `optedOut`
    or `disable` that isn't a list, no options at all) are ignored or converted with one warning, never thrown. With
    `@shardlens/http`, one bad option made every wrapped handler fail.
  - Erasing a user drops their events still waiting to be sent (in memory, waiting for a retry, or in the disk spool),
    so they can't arrive after the erasure and survive it.
  - REST routes hold route words only: invite and template codes, tokens, query strings and any other value become
    placeholders, so they never leave the bot or become metric labels.
  - `captureOptionValues` never records user, channel, role, mentionable or attachment options, nor any value holding a
    Discord ID. Values and names are cut on whole characters, so PostgreSQL never refuses a batch for half an emoji.
  - A bot's own REST `response` listener can read the response body again with Shardlens attached (fetch-based REST,
    Bun, Deno).
  - The disk spool works when shards share a folder: the size cap covers the folder, a segment is never handed out again
    after it was accepted (even on a read-only volume), and leftover temp files are cleaned up. Events go to the spool
    during an outage that started before the collector was first reached.
  - No salt yet for the current period (a clock slightly ahead of the collector's) is asked for again within seconds, not
    an hour later, and a clock more than 30 seconds off is warned about once. The SDK keeps three salts, so the next
    period's, which the collector now sends just before a boundary, is ready when it starts.
  - Replies from the collector are read up to a size limit; secret redaction takes linear time on long input.
  - Retries never come sooner than the backoff, whatever `Retry-After` says; a failed batch goes back in one step.
  - `shutdown()` accepts `null` and non-numeric timeouts, and aborts requests still hanging when it ends, so the process
    can exit.
  - `refreshGuildCounts` doesn't pile up requests while Discord is slow, and two Shardlens instances on one client
    restore the REST client whatever order they shut down in.
  - Dry-run output hides audit identities, error listeners get errors with tokens and request bodies removed, and opted-out
    IDs may be BigInts.

- c220106: A second `shutdown()` call waits for the flush the first one started instead of returning at once. With a shard
  manager, Ctrl+C sends `SIGINT` from the terminal and then `SIGTERM` from the manager, and the second handler used to
  exit the process before the last events were sent.

## 1.0.0

### Major Changes

- 75713a7: 1.0.0, the first stable release. From here a breaking change to a package's API, the CLI, the collector's HTTP API or
  its environment variables only comes in a new major version, with a migration note. The wire format keeps its own
  major version, which a collector accepts alongside the previous one.

### Minor Changes

- 680bb7c: Prometheus and OpenTelemetry exporters. Pass `exporters: [prometheusExporter()]` or `[openTelemetryExporter()]` to
  `createShardlens` to get bot-health metrics (interactions by command and outcome, response time, REST, rate limits,
  shards, memory) in your own monitoring, with or without a collector: `endpoint` and `apiKey` are now optional.
  Exporters see every event before sampling, never with a user, and no metric is labelled by user or server ID.
- 680bb7c: First release: privacy-first analytics and health monitoring for discord.js bots. The SDK hashes user IDs in-process,
  batches events with retries and never throws into the bot; the discord.js adapter records interactions, REST health,
  servers, shards and premium events through public hooks only; the CLI sets up a self-hosted collector.
- 680bb7c: New `@shardlens/http` package for bots that receive interactions over HTTP (Cloudflare Workers, Deno, Bun,
  `@discordjs/core`). `createShardlensHttp(options).wrapInteractionHandler(handler)` records each interaction with the
  same fields as the discord.js adapter, times the answer against the 3-second deadline and sends events through
  `waitUntil` when the runtime provides it. Core gains `client.idle()` to wait for salts and hashing before a flush.
- 680bb7c: Disk spool and member-count refresh. `spool: { dir }` keeps events on disk during long collector outages and across
  restarts (NDJSON segments, 100 MB cap, oldest evicted first), replays them first when the collector is back and
  deletes them only once accepted; spool files never contain user IDs or audit identities. `refreshGuildCounts: true`
  refreshes approximate member counts one server every two seconds. Core gains the `EventSpool` interface.

### Patch Changes

- 680bb7c: Clearer logs. The SDK says once when it can't reach the collector (and once when it is back) instead of only counting
  the failure. The collector logs a startup summary, rejected events with their reasons, failed Discord sign-ins and
  failed live updates, includes a `requestId` in `500` replies that matches its log line, and records an alert whose
  webhook can no longer be decrypted in that alert's history.
- 680bb7c: Hardening before the first release. The collector rate limits every route per client address (unknown paths
  included), checks the ingest key before reading the request body, keeps real keys cached through floods of made-up
  ones, and runs its own forward-only migration runner on PostgreSQL and in embedded mode. `shardlens doctor` now
  detects discord.js 15. Core exports the small helpers the adapters share (`errorClass`, `errorCode`, `compact`,
  `DEFAULT_DURATION_BUCKETS`).
- 680bb7c: Scheduled reports: a daily or weekly summary (commands, unique users, failures, response time, servers, top commands)
  posted to a Discord channel through its webhook, set up on the new Reports page. Identified users (audit mode) now
  record exactly a user ID, a username and an avatar: `auditIncludeProfile` (default `true`) replaces
  `auditIncludeNames`, the display name is no longer collected, and the Activity log shows the avatar.
  `shardlens init --identify-users` creates the audit key, and `shardlens privacy --ids-only` replaces `--names`.
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
