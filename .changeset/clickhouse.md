---
'@shardlens/collector': minor
---

ClickHouse analytics store (preview). With `CLICKHOUSE_URL` set, ingest also mirrors accepted interactions and custom
events into ClickHouse (MergeTree raw tables with a 35-day TTL, AggregatingMergeTree minute rollups), and series, top
and heatmap queries for them are answered from ClickHouse for ranges it covers. PostgreSQL stays the system of
record; erasure covers both.
