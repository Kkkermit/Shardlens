# 0012. Run embedded mode on PGlite, not SQLite

- Status: Accepted (open to revisiting: see Consequences). The case against a second storage engine is revisited in [0021](0021-mongodb-storage-engine.md).
- Date: 2026-11-13

## Context

Spec sections 9 and 16.4 describe embedded mode (the collector inside the bot process, for small bots on one host) on
SQLite with `better-sqlite3`: "same tables without partitioning, histogram helpers implemented in TypeScript".

By M4 the collector's storage is far more PostgreSQL-specific than the spec's reference code:

- About 2,000 lines of SQL across ingest, rollups, queries, salts, retention, audit and alerts.
- PL/pgSQL histogram aggregates (`shardlens_hist_*`), daily range partitions created at runtime, `jsonb` operators
  and `GROUPING SETS`, `percentile_cont`, `bytea`, arrays and `= ANY($1::bigint[])`.
- `LISTEN/NOTIFY` for live tiles and an advisory lock for job leadership.

A SQLite adapter would be a second implementation of all of it, with its own bugs, tested separately for ever. Every
future query would have to be written twice.

PGlite (`@electric-sql/pglite`, PostgreSQL 17 compiled to WebAssembly, MIT/Apache-2.0) runs in-process in Node and
stores its data in a folder. A spike on 13 Nov 2026 applied migrations 001–003 unchanged, including the PL/pgSQL
functions. Parameters (bytea, arrays, timestamps, jsonb), advisory locks and `LISTEN/NOTIFY` all worked. The only
differences from `pg` are type parsing (int8 as BigInt, bytea as Uint8Array), which parsers fix.

## Decision

Embedded mode runs the collector unchanged on PGlite:

- `@shardlens/collector/embedded` exports `startEmbeddedCollector({ dataDir, appId, … })`. It opens PGlite in
  `dataDir/db`, applies the SQL migrations (recorded in `pgmigrations` the way node-pg-migrate records them), generates
  secrets and keys once in `dataDir/secrets.json` (mode 0600), and starts the same server and jobs as the standalone
  collector (`startCollector`, shared with `main.ts`).
- A small adapter (`storage/pglite.ts`) gives PGlite the part of the `pg` Pool API the collector uses. PGlite has one
  connection, so statements are serialised and a transaction holds the connection until it ends. Code inside a
  transaction must use the transaction client (true today: ingest is the only transaction).
- `@electric-sql/pglite` is an optional peer dependency of `@shardlens/collector`, which is now published so bots can
  install it. The Docker image doesn't include PGlite.
- The SDK talks to the embedded collector over HTTP on 127.0.0.1, so validation, authentication and dedupe are the
  same code paths as in production.

## Consequences

- One storage implementation and one test suite. New queries work in embedded mode automatically, and an embedded test
  (`test/embedded.test.ts`) runs the SDK → collector → query path on PGlite in `pnpm check`.
- PGlite is about 3 MB of WebAssembly and takes about a second to start. Every query is serialised on one connection,
  which suits the small bots embedded mode is for. Larger bots should use the standalone collector.
- This departs from the spec's `better-sqlite3` choice. If a real SQLite need appears (for example a host where
  WebAssembly is unavailable), the `StorageAdapter` interface sketched in spec 16.4 is still the way to add one.
- Moving an embedded database to a standalone PostgreSQL needs a dump from PGlite (`pg_dump` from
  `@electric-sql/pglite-tools`). It isn't automated yet.
