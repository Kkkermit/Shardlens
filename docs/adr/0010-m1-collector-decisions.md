# 0010. Collector and dashboard choices made during M1

- Status: Accepted
- Date: 2026-11-13

## Context

M1 built the collector, Postgres storage and dashboard. Where the spec was silent or a detail didn't survive contact
with real data, the simplest safe option was taken and is recorded here.

## Decisions

| Area                         | Spec                                 | Decision                                                                                                                                                                  | Why                                                                                                                                 |
| ---------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `rollup_1h`, `rollup_1d`     | Partitioned monthly / yearly         | Plain tables, trimmed by date                                                                                                                                             | Counts only and small; monthly/yearly partition management added code for no benefit                                                |
| Rollups older than 14 days   | Cascade minute → hour → day          | Hours and days older than minute retention are recomputed **straight from raw rows**                                                                                      | Late events (outage replay) older than 14 days have no minute partition to land in                                                  |
| Partitions per table         | 7 days ahead                         | Each table's partitions start at the beginning of its own retention window                                                                                                | Gauges keep 30 days, raw 35: one old gauge must not fail a whole batch                                                              |
| Ingest age limit             | 35 days                              | Per event type: raw retention (app setting), gauges 30 days; older events are rejected per event as `too_old`                                                             | A partition miss would 500 the batch, and the SDK correctly retries it forever (poison batch)                                       |
| Salt periods at ingest       | Not specified                        | Hashes are accepted only for periods whose salt is still alive (`unknown_salt_period` otherwise)                                                                          | Stops arbitrary period labels creating partitions, and stops hashes for destroyed periods                                           |
| First snapshot               | Diff joins/leaves                    | The first complete snapshot imports servers as a **baseline** (no join events); later snapshots diff per shard using `(id >> 22) % shard_count`                           | Installing Shardlens on an existing bot would otherwise count every server as a join on day one                                     |
| CSRF                         | `@fastify/csrf-protection`           | Mutations with a session require the `x-shardlens-csrf: 1` header; no CORS is served                                                                                      | Browsers can't add custom headers to cross-site requests without a preflight that fails; simpler than token plumbing for a JSON API |
| Dashboard login              | Discord OAuth2                       | Discord OAuth2 (owner/team only) **plus** read-key login                                                                                                                  | Quick start without an OAuth app; read keys are 32 random bytes and the route is rate limited                                       |
| Request decompression        | Not specified                        | Disabled on every route; ingest does its own bounded gunzip                                                                                                               | `@fastify/compress` would otherwise inflate request bodies without the 5 MB gzip-bomb cap                                           |
| Request logs                 | pino with redaction                  | Route scopes log at `warn` unless the collector runs at `debug`                                                                                                           | Per-request info logs would record URLs such as the OAuth callback's one-time code                                                  |
| Live tiles                   | In-memory counters + `LISTEN/NOTIFY` | Counted by **event time**, last 15 minutes only                                                                                                                           | Replayed or backfilled batches must not look live                                                                                   |
| Migrations                   | node-pg-migrate                      | node-pg-migrate with plain `.sql` files                                                                                                                                   | Reviewable SQL; the runner's advisory lock lets several collectors start together                                                   |
| Dashboard routing and styles | File-based routes, CSS Modules       | Code-based TanStack Router routes, one token stylesheet + one app stylesheet                                                                                              | Fewer moving parts (no route codegen); every colour is a token, light and dark                                                      |
| Charts                       | uPlot + canvas heatmaps              | uPlot for time series; the heatmap is a CSS grid                                                                                                                          | 168 cells don't need canvas, and the grid gets hover titles and a table view for free                                               |
| Chart palette                | Not specified                        | The data-viz reference palette, validated for light and dark (adjacent CVD ΔE ≥ 8); grouped charts cap at 3 series; every chart has a legend (2+ series) and a table view | The light aqua slot is below 3:1 contrast, so a table view is mandatory                                                             |

## Consequences

- `apps/collector/test/collector.int.test.ts` covers each of these (late rollups, per-table age limits, baseline
  snapshots, CSRF header, gzip bomb).
- The demo seeder (`node dist/cli/seed.js`) sends traffic through the real SDK client, so it doubles as an end-to-end
  smoke test.
