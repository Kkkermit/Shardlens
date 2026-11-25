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
([0021](0021-storage-behind-one-interface.md), `apps/collector/src/storage/store.ts`). `PostgresStore` holds today's
SQL; `MongoStore` implements the same interface on MongoDB. Routes, validation, authentication, rate limits, CSRF, the
dashboard, `@shardlens/client` and the OpenAPI document are shared, so the second engine is storage and queries only.

**Three ways to run it, all on the owner's MongoDB:**

- **In the bot, nothing else to run.** `createShardlens(client, { mongodb: process.env.MONGODB_URI })`. Once the bot
  knows its application ID, the SDK loads `@shardlens/collector/mongodb` (an optional peer) and hands it its batches
  in process, through the SDK's `fetch` hook answered by Fastify's `inject`, so batching, retries, the spool and
  validation are the same code paths as with a collector. No keys, no ports, no Docker. Every process of a sharded
  bot writes to the same database and shares one set of keys, generated once per app; background jobs run in one of
  them at a time, on a lease in MongoDB. The dashboard can be served from the bot (`dashboard: { port }`); the first
  process to take the port serves it.
- **The dashboard on demand.** `npx shardlens dashboard` finds the connection string in the environment or the bot's
  `.env`, runs the collector from the `@shardlens/collector` installed beside the bot, and serves the dashboard on
  `127.0.0.1`.
- **A hosted dashboard.** The collector image starts on MongoDB when `DATABASE_URL` is a `mongodb://` or
  `mongodb+srv://` URL, for a public dashboard, alerts, reports and webhook events on any host, with no PostgreSQL.
  It needs no session secret or settings key of its own: it uses the ones the bot generated.

**One-time sign-in links.** A dashboard run from a terminal or in the bot prints a link that signs its owner in with
the owner's rights, settings included: whoever can see it already holds the database. Each link works once, within 15
minutes, and lives in that process's memory only. Collectors started from the image, or in embedded mode, don't offer
them (a migration lets PostgreSQL hold such sessions all the same, so the session type is the same on both stores).

**Data model.** Collections are prefixed `shardlens_` in the database the URI names (or `shardlens`), so they sit
beside the bot's own without clashing: one per PostgreSQL table, with the columns in camelCase and NULL columns left
out. A single event's `_id` is its UUIDv7, which makes a retried batch a no-op, as the event ID primary keys do in
PostgreSQL. There are no transactions and no change streams, so a standalone server works as well as a replica set
or Atlas: where PostgreSQL relies on a transaction, every MongoDB write is an insert by `_id`, an upsert or a
conditional update, so a batch that failed partway is completed when the SDK sends it again. Rollups are recomputed
for each dirty minute and written by a deterministic `_id`, replacing documents rather than incrementing them, so a
recompute is idempotent and late events are handled the way PostgreSQL handles them. Retention is the same daily job
as on PostgreSQL, deleting by time with each app's settings as they stand; sessions and live-tile shares expire by TTL
index. Indexes are created when their layout version changes, so a start costs one read.

**Same privacy model.** User IDs are hashed in the bot with the period's salt, as before. Salts live in
`shardlens_salts` and are deleted seven days after their period ends, as on PostgreSQL, which makes the hashes they
produced unlinkable; unique-user rows go with them. The audit key is never stored in MongoDB (an environment variable
or option only). There is still no per-user view and no `groupBy: user`.

**Secrets.** The session secret, settings key and the app's ingest, read and activity keys are generated on the first
start and kept in `shardlens_secrets`. Anyone who can read that database can read them, and with them use the
dashboard; that is no more than the database itself gives. `SHARDLENS_SETTINGS_KEY` in the environment (or the
`settingsKey` option) overrides the stored settings key for owners who want them apart. Generated keys carry their own
label, so keys set in the image's environment and the bot's never revoke each other.

**Sized for the free tier.** Writes are batched per flush (an `insertMany` per event collection in the batch, a
`bulkWrite` per upsert target), live tiles cost nothing while no dashboard is open, and the job leader's lease is
renewed three times a minute. Single events keep the same 35-day default as on PostgreSQL, changed in Settings, and
long-range charts read hourly and daily rollups.

**Parity is tested, not promised.** The collector's integration suites run against both stores (MongoDB 7.0 and 8.0
as a standalone server in CI), and MongoDB's own suites compare its answers with PostgreSQL's for the same data, so an
answer that differs between engines fails CI.

## Consequences

- Setting Shardlens up with MongoDB is one option and one install. The PostgreSQL collector, embedded mode on PGlite,
  sinks and ClickHouse keep working as they do.
- Every new query, metric or admin feature is now written twice, once per store, and is covered by the shared suites.
  This is the cost 0012 and 0019 avoided; it is accepted.
- MongoDB mode has no ClickHouse mirror (the image refuses `CLICKHOUSE_URL` with a MongoDB `DATABASE_URL`), and sinks
  are unnecessary there: the data already lives in the owner's database.
- A bot past the free tier's 100 operations per second needs a paid MongoDB tier or the PostgreSQL collector; the docs
  say where that line is.
- Moving data between the two stores isn't automated.
