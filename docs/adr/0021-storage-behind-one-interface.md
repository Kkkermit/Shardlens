# 0021. Put the collector's storage behind one interface

- Status: Accepted
- Date: 2026-11-24

## Context

Bot owners asked to keep everything in the MongoDB they already run, with the same dashboard and every feature.
[0019](0019-event-sinks.md) answered with sinks, copies of accepted events, because a second storage engine meant a
second copy of about 2,000 lines of SQL. That SQL was spread through routes, jobs, live tiles, auth and the query code,
so a second engine would also have meant a second HTTP layer. [0012](0012-embedded-mode-on-pglite.md) left a storage
interface as the way to add another engine.

The cost of a second implementation of the storage is now accepted. Validation, authentication, rate limits, the
HTTP API and the dashboard must not be duplicated with it.

## Decision

- **One `Store`.** `apps/collector/src/storage/store.ts` is the only way the collector reads or writes what it keeps,
  grouped by area: apps, keys, sessions, settings, salts, ingest, webhook events, queries, alerts, reports, privacy,
  admin audit, live tiles, jobs and the demo seeder. Routes, the key cache, live tiles, the scheduler and start-up use
  `deps.store` and nothing else.
- **Plain values only.** No SQL, connections, transactions, locks or `LISTEN/NOTIFY` in the interface. Where
  PostgreSQL needs a transaction (ingest), a row lock (snapshots) or an advisory lock (partitions, the job leader),
  it takes it inside the method. Leadership is a `JobLeader` the store hands out, which a lease can implement. Live
  tiles go through a `LiveChannel`, which a store with no push can implement by polling.
- **The rest is engine-neutral.** HTTP, zod validation, rate limits, sign-in, encryption, the salt lifecycle, query
  spec checks and dimension codes stay outside the store. Who ran a command is encrypted before a batch reaches it;
  an erase hashes the user ID outside it. The ClickHouse analytics store is asked for series, top and heatmap before
  the store, and sinks receive what the store accepted ([0013](0013-m3-m4-decisions.md), 0019), whichever engine it is.
- **Answers are typed once.** Query methods return `QueryAnswer<kind>`, the shape `@shardlens/client` types, so `tsc`
  checks a second engine against what the dashboard and the client read. `test/client.int.test.ts` checks every answer
  of a running collector against the same types.
- **PostgreSQL is one implementation.** `PostgresStore` (`storage/postgres/`) holds the SQL, moved without being
  rewritten. Migrations, `db.ts` and the PGlite adapter stay PostgreSQL's own. Embedded mode is unchanged.
- **One test suite.** `startHarness({ store })` builds the store under test, PostgreSQL by default, and the suites
  use `h.store`. `h.db` remains for tests that check PostgreSQL itself (partitions, locks, time zones).

## Consequences

- A second engine implements `Store` and runs the same suites. Nothing above the store changes for it.
- Every new storage need is a method on the interface, documented for every engine, not a query in a route.
- A few methods only mean something on PostgreSQL (`prepare` and `jobs.ensurePartitions` create partitions,
  `refusedInput` reads PostgreSQL error codes); another engine does what its storage needs there, or nothing.
- PostgreSQL stays the default and the only engine, and behaviour is unchanged: same statements, same answers.
