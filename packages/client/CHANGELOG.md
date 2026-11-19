# @shardlens/client

## 1.0.0

### Major Changes

- e761c8c: New package: `@shardlens/client`, a typed client for reading a collector from your own dashboard or scripts. It
  starts at 1.0.0, and its exports are covered by semantic versioning like the other packages'.

  - `createShardlensClient({ endpoint, apiKey })` takes the collector's address and a read key (`slk_read_…`) or an
    activity key (`slk_activity_…`), under the same option names as the SDK. Making a client never throws, so a module
    that makes one still loads without its settings (a build, a test run); each call then rejects with
    `invalid_options` and says what is wrong: a missing setting, an ingest key, or an address that isn't HTTPS (plain
    HTTP is allowed to localhost only) or has a path.
  - One method for each query the Shardlens dashboard runs, with typed answers: `overview`, `commands`, `command`,
    `series`, `top`, `heatmap`, `servers`, `server`, `growth`, `audience`, `reliability`, `gauge`, `bursts`, `premium`,
    `installs`, `events`, `eventProps`, `funnel` and `retention`. `query(spec)` runs any of them, and `lastDays(7)`
    makes a range.
  - `meta()` reads the app's name, mode, salt period and time zone. `live()` reads the live numbers as an async
    iterable over Server-Sent Events: it ends when its signal aborts, closes the connection when the loop is left, and
    throws a `timeout` when the collector has sent nothing, not even its heartbeat, for 45 seconds.
  - `activity.log(filters)` and `activity.topUsers(window)` read who ran what from a collector in audit mode, with an
    activity key. The log is paged by passing each page's `nextBefore` back as `before`.
  - Every failure is a `ShardlensClientError` with the HTTP `status`, the collector's error `code`, `retryAfterSeconds`
    after a 429 and the `requestId` of a 500. A timeout (10 seconds unless `timeoutMs` says otherwise) or an unreachable
    collector has status 0. The key is never part of a message, and redirects are not followed, so the key goes to
    the collector's address only.
  - No dependencies, and Web-standard APIs only: it runs on Node.js 20 and later, Bun, Deno, Cloudflare Workers and in
    Next.js route handlers.
