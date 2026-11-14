---
'@shardlens/collector': patch
'@shardlens/core': patch
'shardlens': patch
---

Hardening before the first release. The collector rate limits every route per client address (unknown paths
included), checks the ingest key before reading the request body, keeps real keys cached through floods of made-up
ones, and runs its own forward-only migration runner on PostgreSQL and in embedded mode. `shardlens doctor` now
detects discord.js 15. Core exports the small helpers the adapters share (`errorClass`, `errorCode`, `compact`,
`DEFAULT_DURATION_BUCKETS`).
