---
'@shardlens/collector': minor
---

Copy every accepted event into your own database. Set `SHARDLENS_SINK_URL` to a `mongodb://`, `mongodb+srv://`,
`mysql://`, `mariadb://`, `postgres://` or `sqlite:` URL (or pass `sink` to `startEmbeddedCollector`, which also
accepts a sink you write), and each event is written there once, with hashed users only. Erasure and retention
(`SHARDLENS_SINK_RETENTION_DAYS`, default 35) reach the copy. The dashboard keeps using PostgreSQL or PGlite.
