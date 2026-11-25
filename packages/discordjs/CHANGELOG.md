# @shardlens/discordjs

## 1.2.0

### Minor Changes

- 7919676: `isExpectedError` tells Shardlens which errors your handlers throw on purpose, for a user's mistake your error handler
  then explains, such as `(error) => error instanceof UserError`. Those runs count as runs, not failures, so failure
  rates show bugs only. The error is still re-thrown to your code.
- 7919676: Keep everything in the MongoDB your bot already uses, with nothing else to run. Install `@shardlens/collector` beside
  the SDK and give it your connection string:

  ```ts
  createShardlens(client, { mongodb: process.env.MONGODB_URI });
  ```

  The collector then runs inside the bot, on your database (Atlas, its free tier included, a replica set or a single
  server, MongoDB 7.0 or newer), in collections prefixed `shardlens_`. Like the SDK, it needs Node.js 22.12 or newer:
  the collector package no longer asks for 24.11, embedded mode included. Every process of a sharded bot writes to the
  same database and shares one set of keys, and the background jobs run in one process at a time. The dashboard, alerts,
  reports, privacy model and every number are the same as on PostgreSQL.

  - `npx shardlens dashboard`, run in the bot's folder, finds the connection string in your `.env` and serves the
    dashboard on `127.0.0.1` with a one-time sign-in link. `--env NAME` reads it from the setting your bot calls `NAME`,
    so a name outside the usual ones needs no `--uri` (and no password in your shell history).
  - `mongodb: { uri, dashboard: { port } }` serves the dashboard from the bot instead, and logs a sign-in link.
  - `mongodb: { uri, database }` keeps the collections in a database of your choice, for a database user allowed into
    one database only (`npx shardlens dashboard --database` reads the same).
  - Each bot process opens at most 5 connections to MongoDB (10 while it serves the dashboard), unless the connection
    string sets `maxPoolSize`.
  - The collector image starts on MongoDB when `DATABASE_URL` is a `mongodb://` or `mongodb+srv://` URL, and then
    needs no session secret or settings key of its own.
  - `@shardlens/collector/mongodb` exports `startMongoCollector`, for running it yourself.

  The PostgreSQL collector is unchanged and stays the way to go without MongoDB.

### Patch Changes

- 1b88d8a: Half the CPU per interaction on a busy bot. Two maps the SDK writes on every interaction evicted their oldest entry
  one at a time, and in V8 each such eviction steps over every slot left by earlier ones, so once the maps were full
  (after 20,000 interactions) each write cost time in proportion to their size. They now evict a sixteenth of their
  entries at a time. The overhead benchmark went from 40–45 µs to about 21 µs of CPU per interaction, with no change
  in memory.
- 7919676: Wrapped handlers inside one another (a wrapped listener calling a wrapped command, or a framework's wrap around
  yours) now record one run: the outermost is timed, and the first error any of them throws is kept. Before, an outer
  handler that caught an inner one's error could erase it, and an inner one finishing could send the row early with
  only its own time.
- Updated dependencies [7919676]
  - @shardlens/core@1.2.0

## 1.1.0

### Minor Changes

- c220106: Runs on every discord.js release it claims, and keeps events whole when values are out of range:

  - The ES module build no longer fails to load on discord.js 14 releases that don't export `ApplicationIntegrationType`
    or `InteractionContextType` (14.14 and 14.15, among others), and buttons, select menus, modals and autocomplete are
    recorded on 14.18 and older, which have no `isPrimaryEntryPointCommand()`. The peer range now starts at
    discord.js 14.12: earlier releases use `@discordjs/rest` 1, whose responses the SDK can't read. Application info is
    sent on releases without `fetchSKUs()` (before 14.15).
  - A global rate-limit wait is recorded with scope `global` (discord.js reports every wait as `user`), and a component
    whose handler fails after its row was sent is attributed to the command that created its message.
  - Numbers the wire format refuses no longer drop the whole event: non-finite rate-limit and invalid-request values,
    negative boosts, out-of-range handler times and error codes that aren't safe integers are clamped or left out, and a
    custom event's server ID must be a valid snowflake (a 20-digit one is left out instead of losing the event).
  - An `async` `onOptOutChange` (or one returning any thenable) that rejects is counted, not left as an unhandled
    rejection that could stop the bot.
  - Events the disk spool deletes at its size cap are counted, in `stats().dropped.spool_evicted` (and as
    `spool_evicted` in SDK health): until now they stayed in `spooled` and were never reported as lost.
  - `/privacy erase` no longer says everything was deleted: in privacy mode an erasure reaches the salt periods the bot
    still holds (the current and the previous one), and the reply and the `forgetUser()` documentation now say so.
  - `CustomEvents` is exported, so typed custom events can be declared on `@shardlens/discordjs`, which also works with
    pnpm, where `@shardlens/core` isn't resolvable from the bot's code.
  - `saltPeriod` is documented as having no effect (the collector decides) and marked deprecated. The published files no
    longer point at source maps they don't include.

- c220106: `lens.handlerStarted(interaction)` and `lens.handlerFinished(interaction, { durationMs, error })` record handler time
  and failures for frameworks that run handlers themselves and announce it, such as Sapphire's
  `chatInputCommandRun`/`chatInputCommandSuccess`/`chatInputCommandError` events. `wrap()` and these methods now accept
  any `BaseInteraction`, including the `ContextMenuCommandInteraction` frameworks pass.
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

- c220106: Fixes from a simulated install on a discord.js 15 development build:

  - npm installs the adapter next to discord.js 15 development builds: the peer range is `^14.0.0 || ^15.0.0-0`.
  - A fatal gateway error on discord.js 15 (an invalid token on re-identify, say) crashes the bot as it does without
    Shardlens. The adapter's `error` listener on `client.ws` used to swallow it and leave the bot running, disconnected.
  - With `ShardingManager` on discord.js 15, whose `client.shard` has no `ids`, events are tagged with the process's
    shards again, and the startup work (server snapshot, application info, command list) runs.
  - After a fresh gateway session, the server snapshot comes from Discord's READY list instead of the cache, so servers
    removed while the shard was away are found (the cache keeps them), and on discord.js 15 servers added meanwhile too.
  - On discord.js 15, a shard's ready state no longer reports every server as unavailable.

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

- 680bb7c: Support discord.js 15 alongside 14. Shard IDs, pings and shard lifecycle events are read through whichever public API
  the installed version has (v15 moved them to `client.ws`, the `@discordjs/ws` manager), and the `/privacy` command
  is plain command JSON now that discord.js 15 no longer re-exports the builders. A nightly CI job runs the adapter
  tests against `discord.js@latest` and `@dev`.
- 680bb7c: Prometheus and OpenTelemetry exporters. Pass `exporters: [prometheusExporter()]` or `[openTelemetryExporter()]` to
  `createShardlens` to get bot-health metrics (interactions by command and outcome, response time, REST, rate limits,
  shards, memory) in your own monitoring, with or without a collector: `endpoint` and `apiKey` are now optional.
  Exporters see every event before sampling, never with a user, and no metric is labelled by user or server ID.
- 680bb7c: First release: privacy-first analytics and health monitoring for discord.js bots. The SDK hashes user IDs in-process,
  batches events with retries and never throws into the bot; the discord.js adapter records interactions, REST health,
  servers, shards and premium events through public hooks only; the CLI sets up a self-hosted collector.
- 680bb7c: Scheduled reports: a daily or weekly summary (commands, unique users, failures, response time, servers, top commands)
  posted to a Discord channel through its webhook, set up on the new Reports page. Identified users (audit mode) now
  record exactly a user ID, a username and an avatar: `auditIncludeProfile` (default `true`) replaces
  `auditIncludeNames`, the display name is no longer collected, and the Activity log shows the avatar.
  `shardlens init --identify-users` creates the audit key, and `shardlens privacy --ids-only` replaces `--names`.
- 680bb7c: Disk spool and member-count refresh. `spool: { dir }` keeps events on disk during long collector outages and across
  restarts (NDJSON segments, 100 MB cap, oldest evicted first), replays them first when the collector is back and
  deletes them only once accepted; spool files never contain user IDs or audit identities. `refreshGuildCounts: true`
  refreshes approximate member counts one server every two seconds. Core gains the `EventSpool` interface.

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
