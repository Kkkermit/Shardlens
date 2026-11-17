---
'@shardlens/client': major
---

New package: `@shardlens/client`, a typed client for reading a collector from your own dashboard or scripts. It
starts at 1.0.0, and its exports are covered by semantic versioning like the other packages'.

- `createShardlensClient({ url, key })` takes a read key (`slk_read_…`) or an activity key (`slk_activity_…`). An
  ingest key, or a URL that isn't HTTPS (plain HTTP is allowed to localhost only), is refused when the client is
  created.
- One method for each query the Shardlens dashboard runs, with typed answers: `overview`, `commands`, `command`,
  `series`, `top`, `heatmap`, `servers`, `server`, `growth`, `audience`, `reliability`, `gauge`, `bursts`, `premium`,
  `installs`, `events`, `eventProps`, `funnel` and `retention`. `query(spec)` runs any of them, and `lastDays(7)`
  makes a range.
- `meta()` reads the app's name, mode, salt period and time zone. `live()` reads the live numbers as an async
  iterable over Server-Sent Events: it ends when its signal aborts, and closes the connection when the loop is left.
- `activity.log(filters)` and `activity.topUsers(window)` read who ran what from a collector in audit mode, with an
  activity key. The log is paged by passing each page's `nextBefore` back as `before`.
- Every failure is a `ShardlensClientError` with the HTTP `status`, the collector's error `code`, `retryAfterSeconds`
  after a 429 and the `requestId` of a 500. A timeout (10 seconds unless `timeoutMs` says otherwise) or an unreachable
  collector has status 0. The key is never part of a message, and redirects are not followed, so the key goes to
  the collector's address only.
- No dependencies, and Web-standard APIs only: it runs on Node.js 20 and later, Bun, Deno, Cloudflare Workers and in
  Next.js route handlers.
