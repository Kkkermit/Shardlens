---
'@shardlens/collector': minor
---

Embedded mode: `startEmbeddedCollector({ dataDir, appId })` from `@shardlens/collector/embedded` runs the collector,
its jobs and the dashboard inside your bot process on an in-process PostgreSQL (PGlite, an optional peer
dependency), with the same SQL as the standalone collector. The collector is now published to npm for this.
