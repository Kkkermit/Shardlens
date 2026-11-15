# 0019. Copy events into the owner's own database through sinks

- Status: Accepted
- Date: 2026-11-15

## Context

Bot owners asked to use the database they already run (often MongoDB, also MySQL, MariaDB, SQLite) instead of adding
PostgreSQL. [0003](0003-storage.md) left MongoDB to contributors and [0012](0012-embedded-mode-on-pglite.md) explains
why the collector's storage is PostgreSQL-only: about 2,000 lines of SQL depend on PL/pgSQL histogram aggregates, daily
partitions, `GROUPING SETS`, advisory locks and `LISTEN/NOTIFY`. A second storage engine would be a second copy of
every query, tested separately for ever.

What owners want from their own database is mostly to see and query their bot's events with tools they know, join
them with their own data and keep them longer. That doesn't need the dashboard to run on it.

## Decision

- **A sink is a copy, not a store.** PostgreSQL (or PGlite in embedded mode) stays the system of record and the
  dashboard's source. A sink receives every event PostgreSQL accepted, after the commit, like the ClickHouse mirror
  ([0013](0013-m3-m4-decisions.md)).
- **One interface, five built-ins.** `EventSink` has `init`, `write`, `erase`, `expire` and `close`. Built-ins are
  chosen by URL scheme (`SHARDLENS_SINK_URL`, or `sink.to` in embedded mode): MongoDB with the official driver,
  MySQL and MariaDB with `mysql2`, PostgreSQL with `pg`, and SQLite with Node's built-in `node:sqlite`. A driver
  loads only when its scheme is used. Embedded mode also accepts a sink object, so owners can write to anything.
- **Idempotent by event ID.** Each built-in ignores an ID it already holds (`_id` in MongoDB, a primary key with
  `ON DUPLICATE KEY UPDATE id = id`, `ON CONFLICT DO NOTHING` or `INSERT OR IGNORE` elsewhere). Retried batches are
  pushed again and stored once, so the sink needs no knowledge of which rows PostgreSQL found new.
- **Never in the way of ingest.** `SinkMirror` buffers up to 20,000 copies, writes in the background in batches of
  500, and drops and counts copies once full. A batch refused three times in a row while the database answers set-up
  is written row by row, and only the rows it refuses are dropped, so one bad row can't block the queue. A sink that is
  unreachable at start-up is retried; the collector starts anyway. Failures are logged at most once a minute, with any
  password in a URL removed.
- **Same privacy rules.** Copies carry the salted hash (32 hex characters and its period), never a user ID. Every
  field the data-collected register marks `personal: 'yes'` is removed before anything is copied (audit-mode `actor`,
  `app_info.dashboardUserIds`), driven by the register so a new identifying field is covered without code changes.
  Erasure deletes a person's copies, including those still in the buffer, and fails the request if the sink can't be
  reached so the caller retries. Copies expire after `SHARDLENS_SINK_RETENTION_DAYS` (default 35, like raw rows; at
  most 3,650), through an index on `ts`; SQLite deletes in chunks so the event loop is never held for long.
- **Generic layout.** One table (or collection) with indexed columns (`id`, `ts`, `app_id`, `env`, `bot_release`,
  `type`, `guild_id`, `user_hash`, `salt_period`) and the whole event in `data`. In MongoDB the event's fields are the
  document's own. New event types need no migration.

## Consequences

- Owners can use any of the five databases without changing how the dashboard works, and any other store by writing a
  sink in embedded mode.
- The collector image grows by the MongoDB and MySQL drivers (a few megabytes).
- Copies kept for longer than a salt period outlive the salt: they can no longer be tied to anyone, and erasure by user
  no longer finds them. The guide says so.
- Webhook events received from Discord are not copied; they don't pass through ingest.
- `test/sinks.int.test.ts` runs every built-in against a real server (MongoDB, MySQL, MariaDB, PostgreSQL) or file
  (SQLite): retries stored once, erasure and retention.
