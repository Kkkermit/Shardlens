# shardlens

## 1.2.0

### Minor Changes

- e761c8c: Choose where you look at the numbers when you set up a collector.

  - `shardlens init --dashboard shardlens | own | none`. `own` turns the Shardlens dashboard off and writes
    `dashboard.env`, the settings the server of your own dashboard needs to read the numbers with `@shardlens/client`.
    `none` runs the collector as an API only. The default is the Shardlens dashboard, as before, and running `init`
    again changes the choice only when the option is given.
  - With `own` or `none`, `--identify-users` also writes `SHARDLENS_MODE=audit` and an activity key, because there is
    no Settings page to switch audit mode on in. The next steps then say to switch the bot to audit mode too.
  - `shardlens keys --scope activity` prints an activity key.

### Patch Changes

- e761c8c: A key set in the collector's environment replaces the one the same variable held before. When `SHARDLENS_INGEST_KEY`,
  `SHARDLENS_READ_KEY` or `SHARDLENS_ACTIVITY_KEY` gets a new value, the collector revokes the old key as it starts, signs
  out dashboard sessions made with it and notes it in the admin log. Before, the old key kept working until it was
  revoked in Settings, which a collector without the dashboard (`init --dashboard own` or `none`) can't open, so a leaked
  key could never be taken back. An embedded collector does the same when a key's line is deleted from `secrets.json`.
  To switch keys without a gap, create the new one in **Settings → API keys** instead. `shardlens keys` says so.
- e761c8c: `shardlens init --force` without `--dashboard` keeps a folder set up for a dashboard of your own as one. With
  `--identify-users` added later, it treated it as having no dashboard: it said there was nothing to open and didn't put
  the new activity key in `dashboard.env`. It now rewrites `dashboard.env` with the keys added since.
- e761c8c: The collector's start-up log says which mode users are recorded in (`mode`) and whether `SHARDLENS_MODE` set it
  (`modeFrom`), so a log shows that audit mode took effect. The `.env` that `shardlens init` writes no longer says the
  dashboard uses the bundled database next to the setting for your own, which read oddly without a dashboard.

## 1.1.0

### Minor Changes

- c220106: `shardlens init` also writes `bot.env` with the two settings your bot needs (`SHARDLENS_URL` and the same
  `SHARDLENS_INGEST_KEY`), so nothing has to be copied out of the collector's `.env` by hand, and a commented
  `SHARDLENS_SINK_URL` for copying events into your own database. `shardlens doctor` reads those two settings from a
  `.env` in the folder it runs in when they aren't set, without changing the environment.
- c220106: Fixes from installing and running the CLI as a new self-hoster:

  - `init --force` no longer breaks a running collector. It used to write a new `.env`, whose new database password locked
    the collector out of PostgreSQL and whose new settings and audit keys made encrypted data unreadable. It now updates
    an existing `.env` in place: it sets the domain and application ID, fills in missing secrets and keeps everything
    else.
  - `init` refuses when any file it writes is already in the folder, so it no longer overwrites a project's own
    `docker-compose.yml`, and says which path it couldn't write and why instead of a bare `EACCES`.
  - `doctor` no longer sends the ingest key over plain HTTP to a collector that isn't on this machine, doesn't follow
    redirects (it reports where they go), stops at a collector that is down instead of reporting the key as rejected,
    checks that `/healthz` really is a Shardlens collector, and explains failures such as an untrusted certificate (with
    `NODE_EXTRA_CA_CERTS` for Caddy's own CA), DNS, refused connections and timeouts. Run in the folder `init` wrote, it
    reads the collector's `SHARDLENS_PUBLIC_URL`, and it says when it can't read the `.env` there.
  - Each command accepts only its own options; a misspelt or misplaced option is an error (exit code 2) instead of being
    ignored. New `--version`, clearer `--help` and `init` next steps.
  - `privacy`: `--ids-only` and `--audit-retention` imply `--audit`, and the paragraph now mentions the permission level
    and premium status that are recorded, and that the pseudonymous code changes at least monthly and can't be linked a
    week after each change.

  `shardlens doctor` accepts discord.js 14.12 and newer and 15, matching what the SDK supports.

### Patch Changes

- c220106: `shardlens init --force` makes the replaced `.env` and `bot.env` readable by their owner only again, and
  `shardlens doctor` says why a request failed (for example `fetch failed (UNABLE_TO_GET_ISSUER_CERT_LOCALLY)`) instead of
  only `fetch failed`.
- c220106: `shardlens privacy` accepts a `--retention` of 7 to 90 days only (what the collector allows) and takes
  `--audit-retention`; `doctor` refuses a collector URL with a user name or password instead of printing it; `init`
  quotes the folder in the command it prints.
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

- 680bb7c: Hardening before the first release. The collector rate limits every route per client address (unknown paths
  included), checks the ingest key before reading the request body, keeps real keys cached through floods of made-up
  ones, and runs its own forward-only migration runner on PostgreSQL and in embedded mode. `shardlens doctor` now
  detects discord.js 15. Core exports the small helpers the adapters share (`errorClass`, `errorCode`, `compact`,
  `DEFAULT_DURATION_BUCKETS`).
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
