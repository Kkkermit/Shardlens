# 0003. PostgreSQL by default, partitioned, no extensions

- Status: Accepted
- Date: 2026-11-13

## Context

Self-hosting must be easy (one `docker compose up`), run on any managed Postgres, and still scale from a hobby bot to
millions of interactions a day. Bot owners mostly know SQL.

## Decision

- PostgreSQL 17+ is the default store (schema tested on 16). No extensions, so it runs on any managed provider.
- Raw tables are range-partitioned by day; expired data is removed by dropping whole partitions, never by `DELETE` on
  hot tables.
- Raw events are kept 35 days and rolled up into per-minute, per-hour and per-day tables that hold only counts and
  fixed 40-bucket log-scale latency histograms (mergeable, so percentiles survive rollups).
- Inserts use `ON CONFLICT (id, ts) DO NOTHING`; UUIDv7 IDs keep the conflict check inside one partition.
- All adapters implement one `StorageAdapter` interface. The dashboard sends a typed query spec, never SQL.
- SQLite (embedded mode) and ClickHouse (very large bots) are later adapters behind the same interface; MongoDB is left
  to contributors.

## Consequences

- A leader (chosen by `pg_try_advisory_lock`) must create partitions ahead of time and run rollups and retention.
- The TypeScript histogram (`@shardlens/core`) and the SQL `shardlens_bucket()` function must stay identical; a test
  pins 120 ms to bucket 16 on both sides.
- The "5 million interactions a day" ceiling is a planning guess until load tests measure it.
