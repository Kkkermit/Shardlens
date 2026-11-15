---
'@shardlens/collector': patch
---

Fixes from simulated self-hosted deployments (Docker Compose behind Caddy, a database outage, two collectors on one
database, an upgrade from 1.0 on a PostgreSQL set to `Asia/Kolkata`, every event sink under load, embedded mode in a
bot process):

- Unique users, reports, partitions, salts and retention ran on schedule again: a job due every 5 minutes ran every 6
  when the job leader was elected between two ticks.
- A privacy erase no longer hangs while your own database (the sink) has stopped answering: it fails after 20 seconds,
  so it is retried. The MySQL, MariaDB and PostgreSQL sinks give up on a query after 30 seconds instead of waiting for
  ever, and the PostgreSQL sink expires old copies in chunks.
- A sink of your own without `init` (as in the docs' example) no longer drops copies while its database is down.
- Command details, Reliability and premium share read raw rows for as long as Settings keeps them (7 to 90 days),
  instead of 35 days whatever the setting, and say from when they counted.
- Sample rates below 1 in 10,000 are refused in Settings: their events would carry a weight the wire refuses.
- Alert history and report errors say why Discord couldn't be reached (`could not reach Discord (ENOTFOUND)`, or a
  timeout) instead of `TypeError`.
- A sink whose database driver isn't installed says which package to install. The ClickHouse client loads only when
  `CLICKHOUSE_URL` is set.
- The image no longer ships the dashboard's source maps, its files are owned by root (the collector's user can't
  change them), and its health check allows two minutes for migrations. The package ships without source map
  comments.
- `/openapi.json` describes the ingest body with the published batch schema, including the privacy-mode rule.
- Docker Compose reads `SHARDLENS_TRUST_PROXY` from `.env` (default `1`), and `.env.example` lists every variable.
