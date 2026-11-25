# @shardlens/collector

## 1.3.0

### Minor Changes

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

- 7919676: A dashboard started from a terminal or inside a bot signs its owner in with a one-time link: each works once, within
  15 minutes, and gives the owner's rights, settings included (whoever can see the link already holds the database).
  Collectors started from the image or with `startEmbeddedCollector` don't offer links. A new migration allows these
  sessions in PostgreSQL.

### Patch Changes

- 7919676: An alert on the invalid-request share (`invalid_requests_pct`) no longer stops the alert job when it fires. The value
  came back from PostgreSQL as text, formatting it for the Discord message threw, and the rules after it in that run
  were not checked.
- 59dc9bc: The dashboard has a `favicon.ico` and an Apple touch icon besides its SVG favicon, so the Shardlens logo shows in
  browsers that don't take an SVG icon, such as Safari, and on a phone's home screen.
- e080470: Batches sent at the same time no longer deadlock. When several shards or processes sent batches at once, two batches
  counting the same people could wait on each other in PostgreSQL. One of them then failed, and under steady load the
  collector fell behind and refused most batches. Each batch now writes its unique-user rows and late minutes in one
  fixed order, and each row once.
- Updated dependencies [7919676]
  - @shardlens/core@1.2.0

## 1.2.0

### Minor Changes

- e761c8c: A key set in the collector's environment replaces the one the same variable held before. When `SHARDLENS_INGEST_KEY`,
  `SHARDLENS_READ_KEY` or `SHARDLENS_ACTIVITY_KEY` gets a new value, the collector revokes the old key as it starts, signs
  out dashboard sessions made with it and notes it in the admin log. Before, the old key kept working until it was
  revoked in Settings, which a collector without the dashboard (`init --dashboard own` or `none`) can't open, so a leaked
  key could never be taken back. An embedded collector does the same when a key's line is deleted from `secrets.json`.
  To switch keys without a gap, create the new one in **Settings → API keys** instead. `shardlens keys` says so.
- e761c8c: Find who ran into a failure. A server's page lists the commands that fail there, and in audit mode it and each
  command's page link to the Activity log narrowed to their failed runs.

  - `GET /v1/audit/log` and its CSV export take `outcome`: `failed` (every outcome but `ok`), `error`, `timeout`,
    `no_response` or `ok`. Two indexes that hold only failures keep the newest ones quick to read in a large log.
  - The Activity log's filters are in the address, so other tools can link to it:
    `/activity?guild=<server ID>&command=<name>&outcome=failed`. A user ID is never part of the address.
  - Dashboard addresses are plain text. A Discord ID in a hand-written link used to be read as a number and rounded to
    another ID; links made before this change still open.

- e761c8c: Live streams (`/v1/live`) send a heartbeat comment every 15 seconds, whatever the database does. A reader can tell a
  quiet stream from a connection that died without either end closing it, and proxies that close idle connections keep
  the stream open. `@shardlens/client`'s `live()` gives up on a stream that sends nothing for 45 seconds.
- e761c8c: The dashboard is optional, and nothing is kept for it alone.

  - `SHARDLENS_DASHBOARD=off` (`dashboard: false` for an embedded collector) serves the API without the dashboard
    pages, for a dashboard of your own or none. Ingest, queries, jobs, reports and alerts carry on; their Discord
    messages no longer link to a dashboard.
  - Activity keys (`slk_activity_…`, scope `activity`) read the activity log and top users in audit mode from the
    server side of your own dashboard, and everything a read key reads. Create one under **Settings → API keys**, or
    set `SHARDLENS_ACTIVITY_KEY`; an embedded collector returns one as `activityKey`. Each read is written to the
    access log under the key's label. A read key is answered with `403 activity_key_required`; exporting, settings and
    key management still need a Discord sign-in.
  - `SHARDLENS_MODE` (`mode` for an embedded collector) chooses hashed or identified users in the collector's own
    configuration, which is how audit mode is chosen without a Settings page. When it is set, Settings shows the mode
    and can't change it.

### Patch Changes

- e761c8c: A server that ran a command and removed the bot within one batch of events (a short-lived install, or events replayed
  after an outage) is counted as activated on the Growth page and keeps its last command time. Before, the command was
  dropped from the server's record because the removal had already been applied. Commands a user install runs in a
  server after the bot was removed are still not counted as that server's.
- e761c8c: The collector stops while live streams are open. Closing waited for every open `/v1/live` stream, which never ends on
  its own, so a collector with the Overview page (or a `live()` reader) open didn't exit on `SIGTERM`, and
  `collector.close()` of an embedded collector kept the bot running. Open streams are now ended on shutdown, and readers
  see the stream end.
- e761c8c: The collector's start-up log says which mode users are recorded in (`mode`) and whether `SHARDLENS_MODE` set it
  (`modeFrom`), so a log shows that audit mode took effect. The `.env` that `shardlens init` writes no longer says the
  dashboard uses the bundled database next to the setting for your own, which read oddly without a dashboard.
- e761c8c: The `command` and `reliability` queries answer 0, not `null`, for a count or share that is zero while runs happened:
  a command that ran 6 times and never succeeded has `ok: 0`, and one that never deferred has `deferRate: 0`. `null`
  still means nothing ran in the range, as documented.

## 1.1.0

### Minor Changes

- c220106: Fixes from simulated deployments (Docker Compose behind Caddy, Railway and Render templates, `ShardingManager` and
  discord-hybrid-sharding bots):

  - `SHARDLENS_TRUST_PROXY` (and `trustProxy` for the embedded collector) accepts the number of proxies in front, such
    as `1`. With `true`, the client address is the left-most `X-Forwarded-For` entry, which a visitor can write when
    the proxy appends to the header, and the sign-in rate limit could be dodged. The Compose file and the Render
    template now use `1`.
  - Servers a sharded bot reports before its last shard's first snapshot are existing installs, not joins: they no
    longer show up in size at install, activation, cohorts and lifetimes.
  - A restarted shard or cluster process is counted once in gauges (memory, cache sizes, server counts), not added to
    the process it replaced for a minute (or, on the Reliability page, for two).
  - The dashboard page is revalidated after an upgrade instead of being served from cache with the old script names;
    hashed assets stay cached for a year.
  - The `commands` query returns the kinds each command ran as (`chat_input`, `message_command`, menus), and `command`
    its runs per kind. The dashboard writes `/` only in front of slash commands and marks prefix commands and menus.
  - The image build installs dependencies once.

- c220106: Copy every accepted event into your own database. Set `SHARDLENS_SINK_URL` to a `mongodb://`, `mongodb+srv://`,
  `mysql://`, `mariadb://`, `postgres://` or `sqlite:` URL (or pass `sink` to `startEmbeddedCollector`, which also
  accepts a sink you write), and each event is written there once, with hashed users only. Erasure and retention
  (`SHARDLENS_SINK_RETENTION_DAYS`, default 35) reach the copy. The dashboard keeps using PostgreSQL or PGlite.
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

- c220106: Fixes from simulated self-hosted deployments (Docker Compose behind Caddy, a database outage, two collectors on one
  database, an upgrade from 1.0 on a PostgreSQL set to `Asia/Kolkata`, every event sink under load, embedded mode in a
  bot process):

  - Unique users, reports, partitions, salts and retention ran on schedule again: a job due every 5 minutes ran every 6
    when the job leader was elected between two ticks.
  - A privacy erase no longer hangs while your own database (the sink) has stopped answering: it fails after 20 seconds,
    so it is retried. The MySQL, MariaDB and PostgreSQL sinks give up on a query after 30 seconds instead of waiting for
    ever, and the PostgreSQL sink expires old copies in chunks.
  - A sink of your own without `init` (as in the docs' example) no longer drops copies while its database is down.
  - Command details, Reliability and premium share read raw rows for as long as Settings keeps them (7 to 90 days),
    instead of 35 days whatever the setting, and say from when they counted.
  - Sample rates below 1 in 10,000 are refused in Settings: their events would carry a weight the wire refuses.
  - Alert history and report errors say why Discord couldn't be reached (`could not reach Discord (ENOTFOUND)`, or a
    timeout) instead of `TypeError`.
  - A sink whose database driver isn't installed says which package to install. The ClickHouse client loads only when
    `CLICKHOUSE_URL` is set.
  - The image no longer ships the dashboard's source maps, its files are owned by root (the collector's user can't
    change them), and its health check allows two minutes for migrations. The package ships without source map
    comments.
  - `/openapi.json` describes the ingest body with the published batch schema, including the privacy-mode rule, and
    carries the collector's version instead of `0.0.0`.
  - Docker Compose reads `SHARDLENS_TRUST_PROXY` from `.env` (default `1`), and `.env.example` lists every variable.
  - Discord sign-in no longer uses the `arctic` library, which its author has withdrawn: installing the collector prints
    no "package no longer supported" warnings. The requests to Discord are the same.

- c220106: Dashboard:

  - A page that is loading or failed says so, with a retry, instead of looking like "no data"; errors are written in
    words. An Overview left open notices the bot's first events by itself.
  - Each page sets the tab title, moves keyboard focus to its heading and keeps table rows reachable by keyboard.
    Signing out clears what was loaded.
  - Chart axes, tooltips and tables use the browser's locale. An unknown command shows "Command not found".
  - Server search no longer moves the caret or drops a leading space, the last page of a list keeps its controls, and a
    page past the end shows the last page.
  - Long names (the bot's, a server's) wrap instead of widening the page on a phone. Settings messages appear next to
    what they concern, and every admin action confirms.

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

- c220106: Background jobs:

  - Rollups no longer miss events that arrive just under two minutes late, or late events committed while a run is
    going on. A value that can't be summed skips only its own statement instead of stopping every rollup.
  - Each job runs one at a time, so a slow rollup can't build up a queue.
  - Dropping and creating partitions waits at most 2 seconds for a lock, so it can't stall ingest behind a long query.
  - Collectors started together on an empty database no longer crash.
  - Weekly unique users are counted only for weeks inside one salt period, and final counts are never rewritten.
  - A privacy erase no longer waits for a slow copy of the events to empty its whole buffer.
  - Live tiles shared between collectors come back after a database restart.
  - The next salt is served in the last minutes of a period, for bots whose clocks run slightly ahead.
  - Upgrading from 1.0 on a PostgreSQL that isn't set to UTC no longer counts the hours around the upgrade twice: the
    old buckets are moved to UTC.

  Dashboard:

  - When the session ends, the dashboard goes back to the sign-in page. A failed request shows an error with retry,
    never a false "nothing here".
  - Activity pages through every row, and rows sharing a time are no longer skipped.
  - Long, right-to-left or emoji names no longer break layouts or reverse the text next to them. Nothing scrolls
    sideways at phone width, and tables can be scrolled with the keyboard.
  - Settings sends only the fields you changed and always offers the stored time zone. It also gains SKU prices.
  - The Servers list keeps its filters, sort and page in the address.
  - Numbers follow the browser's locale consistently. Prefix commands are written without a slash in funnels and
    filters. There are clearer messages for rate limits and refused fields, a skip link, and focus moves to each new
    page's heading.

- c220106: Hardening from a security review:

  - API and sign-in answers carry `Cache-Control: no-store` unless a route sets its own (public badges), so no browser
    or proxy cache keeps analytics, keys or, in audit mode, the decrypted activity log.
  - One visitor can hold at most 10 of the 100 live-update streams, so a single client (anyone, in demo mode) can't shut
    everyone else out of the live tiles.
  - The data-collected register says that team members' IDs are kept as they are, to check a Discord sign-in.

- c220106: Fixes from a full review of the collector and dashboard:

  - Rollup days are UTC even when PostgreSQL runs in another time zone.
  - A second embedded collector in one process gets its own unique-user partitions instead of failing batches.
  - A collector that fails to start (port in use) stops the jobs and live updates it had started.
  - Live tiles: a broken listening connection is released, large updates are split instead of dropped, retried
    batches are counted once, and slow databases no longer pile up refreshes.
  - The job scheduler keeps one lock connection and one error listener, and releases the lock it may win after stopping.
  - Retried server-availability events and late, older `app_info` reports no longer change stored data.
  - Testing an alert whose stored webhook can't be decrypted answers 502, not 500.
  - ClickHouse: a failed custom-event insert no longer sends interactions twice, and warnings come once a minute with the
    dropped count.
  - Dashboard: the overview chart is no longer rebuilt every second, funnel rows with a repeated step render correctly,
    button groups and status messages are announced properly, and dates follow the app's time zone.

- c220106: Revoking a read key now also signs out the dashboards that signed in with it, and an admin taken off the bot's team
  (or removed from `SHARDLENS_EXTRA_ADMINS`) loses access on their next request instead of when their 7-day session
  ends. Read-key sessions opened before this upgrade end once, so those dashboards ask for the key again.
- c220106: The collector warns at start-up when the bot has no ingest key or nobody could open the dashboard, and Discord sign-in
  says when it is refused because the bot hasn't reported its owner and team yet, instead of "not a team member". The
  docs no longer call both keys optional.
- c220106: Dashboard: a chart whose data is all in one bucket (a new install) shows its point on a two-day axis instead of an
  empty axis spanning about three years, and the Commands page says "this hour" for a command last used in the current
  hour instead of the minutes since the hour began.
- Updated dependencies [c220106]
- Updated dependencies [c220106]
- Updated dependencies [c220106]
- Updated dependencies [c220106]
- Updated dependencies [c220106]
- Updated dependencies [c220106]
- Updated dependencies [c220106]
- Updated dependencies [c220106]
- Updated dependencies [c220106]
- Updated dependencies [c220106]
  - @shardlens/schema@1.1.0
  - @shardlens/core@1.1.0

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
