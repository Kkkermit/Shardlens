# 0022. Store everything in the bot's own MongoDB, as a second storage engine

- Status: Accepted
- Date: 2026-11-24

## Context

Setting Shardlens up asks too much of a bot owner: a server with Docker, a domain, PostgreSQL, Caddy, five secrets and
two keys, or embedded mode with PGlite (Node 24.11+, 350–550 MB of memory, one process only, a data folder that many
bot hosts wipe on redeploy). Owners said it is hard to deploy, costs money to run and is confusing.

Most of them already run MongoDB for the bot itself (often Atlas, often its free tier), with the URI in the bot's
`.env`. They asked to keep their analytics there, with the same dashboard and every feature, and to keep the
PostgreSQL collector as the other option.

[0012](0012-embedded-mode-on-pglite.md) and [0019](0019-event-sinks.md) turned a second storage engine down: about
2,000 lines of SQL would have to exist twice. That reasoning still holds; what changed is the weight given to setup.
The owner chose full parity on MongoDB over a smaller first version.

Constraints from the Atlas free tier, where many of these bots live: 100 operations per second, 0.5 GB of storage,
500 collections, a weekly data-transfer allowance.

## Decision

**One HTTP layer, two stores.** The collector's storage is behind the `Store` interface
([0021](0021-storage-behind-one-interface.md), `apps/collector/src/storage/store.ts`). `PostgresStore` holds today's SQL unchanged; `MongoStore` implements the same
interface on MongoDB. Routes, validation, authentication, rate limits, CSRF, the dashboard, `@shardlens/client` and
the OpenAPI document are shared, so the second engine is storage and queries only. The interface exposes no
transactions, locks or SQL types, so neither engine leaks into the other.

**Three ways to run it, all on the owner's MongoDB:**

- **In the bot, nothing else to run.** `createShardlens(client, { mongodb: process.env.MONGODB_URI })`. The SDK loads
  `@shardlens/collector/mongodb` lazily and hands it its batches in process (through the SDK's `fetch` hook, so
  batching, retries, the spool and validation are the same code paths as with a collector). No keys, no ports, no
  Docker. Every process of a sharded bot writes to the same database; background jobs run in one of them at a time
  (a lease in MongoDB). The dashboard can be served from the same process (`dashboard: { port }`).
- **The dashboard on demand.** `npx shardlens dashboard` reads `MONGODB_URI` from the `.env` the bot uses and serves
  the dashboard and API on `127.0.0.1`, signing the person in with a one-time link printed in the terminal.
- **A hosted dashboard.** The collector image takes `MONGODB_URL` instead of `DATABASE_URL`, for a public dashboard,
  alerts and reports on any host, with no PostgreSQL.

**Data model.** Collections are prefixed `shardlens_` in the database the URI names (or `shardlens`), so they sit
beside the bot's own without clashing. Raw events live in one collection keyed by event ID (`_id`), which makes a
retried batch a no-op, as the event ID primary keys do in PostgreSQL. Rollups (`metric`, grain, bucket, `dims`,
`count`, `sum`, `min`, `max`, histogram) are recomputed from raw events by the scheduled job for each dirty minute,
replacing documents rather than incrementing them, so they are idempotent and late events are handled the way
PostgreSQL handles them. Retention is TTL indexes, not dropped partitions. Unique-user rows expire with their salt.

**Same privacy model.** User IDs are hashed in the bot with the period's salt, as before. Salts live in
`shardlens_salts` and are deleted when their period ends (plus the grace day), which makes the hashes they produced
unlinkable; unique-user rows go with them. The audit key is never stored in MongoDB (an environment variable only).
There is still no per-user view and no `groupBy: user`.

**Secrets.** The session secret and settings key are generated on first start and kept in `shardlens_secrets`.
Anyone who can read that database can read the settings it encrypts; the docs say so, and `SHARDLENS_SETTINGS_KEY`
in the environment overrides the stored one for owners who want them apart.

**Sized for the free tier.** Writes are batched per flush (one `insertMany` of raw events, plus a handful of
counters), raw events are kept for 14 days by default in MongoDB mode (configurable; ingest accepts events only as far
back as raw events are kept, as it does on PostgreSQL, so dedupe by event ID still holds), and long-range charts read
hourly and daily rollups. The docs give the bot size the free tier
fits and what to do beyond it.

**Parity is tested, not promised.** The collector's integration suites run against both stores (MongoDB as a
single-node replica set in CI and locally), so an answer that differs between engines fails CI.

## Consequences

- Setting Shardlens up with MongoDB is one option and one install. The PostgreSQL collector, embedded mode on PGlite,
  sinks and ClickHouse keep working as they do.
- Every new query, metric or admin feature is now written twice, once per store, and is covered by the shared suites.
  This is the cost 0012 and 0019 avoided; it is accepted.
- MongoDB mode has no ClickHouse mirror; sinks are unnecessary there (the data already lives in the owner's database).
- A bot past the free tier's 100 operations per second needs a paid MongoDB tier or the PostgreSQL collector; the docs
  say where that line is.
- Moving data between the two stores isn't automated.
