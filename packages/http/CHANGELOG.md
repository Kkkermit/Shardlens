# @shardlens/http

## 1.1.0

### Minor Changes

- c220106: Fixes found by running an HTTP-interactions bot on Node, Bun, Deno and Cloudflare's own runtime (workerd) against a
  real collector:

  - Cloudflare Workers: recording no longer stops for the rest of a Worker instance's life. A Worker ends whatever a
    request started when the request ends, timers and unanswered requests included, so a collector that took more than a
    couple of seconds to answer the first settings request (one waking from sleep), a new salt period, or a flush started
    by a timer could leave Shardlens unable to send anything again. Under `waitUntil`, each request now sends its own
    events with no timer involved, and a client left stuck by an ended request is replaced by the next one. While the
    collector stays unreachable, it is asked again at most every 1 to 60 seconds.
  - A command answered with a modal records the modal's custom ID, as the discord.js adapter does, so the dashboard's
    modal funnel works for HTTP bots.
  - A PING (Discord checking the endpoint URL) starts nothing: no client, no request to the collector.
  - An argument whose `waitUntil` getter throws no longer makes the wrapped handler throw.
  - Server and command IDs follow the wire format's rule, and response type, channel type and component type must be
    whole numbers, so one odd value no longer gets the whole event refused. An interaction without a user is not sent.
  - Only a JSON `Response` is copied to read the response type; a file or stream is left alone.
  - Exporters keep running when a client is replaced, and are shut down by `lens.shutdown()`.
  - `track()` accepts a BigInt user ID, and ignores a `waitUntil` argument that has no `waitUntil` method.
  - `CustomEvents` is exported, so typed custom events can be declared on `@shardlens/http`, which also works with pnpm,
    where `@shardlens/core` isn't resolvable from the bot's code.
  - The published files no longer point at source maps that are not shipped.

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

- Updated dependencies [c220106]
- Updated dependencies [c220106]
- Updated dependencies [c220106]
- Updated dependencies [c220106]
- Updated dependencies [c220106]
  - @shardlens/core@1.1.0

## 1.0.0

### Major Changes

- 75713a7: 1.0.0, the first stable release. From here a breaking change to a package's API, the CLI, the collector's HTTP API or
  its environment variables only comes in a new major version, with a migration note. The wire format keeps its own
  major version, which a collector accepts alongside the previous one.

### Minor Changes

- 680bb7c: New `@shardlens/http` package for bots that receive interactions over HTTP (Cloudflare Workers, Deno, Bun,
  `@discordjs/core`). `createShardlensHttp(options).wrapInteractionHandler(handler)` records each interaction with the
  same fields as the discord.js adapter, times the answer against the 3-second deadline and sends events through
  `waitUntil` when the runtime provides it. Core gains `client.idle()` to wait for salts and hashing before a flush.
- 680bb7c: Scheduled reports: a daily or weekly summary (commands, unique users, failures, response time, servers, top commands)
  posted to a Discord channel through its webhook, set up on the new Reports page. Identified users (audit mode) now
  record exactly a user ID, a username and an avatar: `auditIncludeProfile` (default `true`) replaces
  `auditIncludeNames`, the display name is no longer collected, and the Activity log shows the avatar.
  `shardlens init --identify-users` creates the audit key, and `shardlens privacy --ids-only` replaces `--names`.

### Patch Changes

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
- Updated dependencies [75713a7]
  - @shardlens/core@1.0.0
