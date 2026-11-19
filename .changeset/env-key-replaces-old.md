---
'@shardlens/collector': minor
'shardlens': patch
---

A key set in the collector's environment replaces the one the same variable held before. When `SHARDLENS_INGEST_KEY`,
`SHARDLENS_READ_KEY` or `SHARDLENS_ACTIVITY_KEY` gets a new value, the collector revokes the old key as it starts, signs
out dashboard sessions made with it and notes it in the admin log. Before, the old key kept working until it was
revoked in Settings, which a collector without the dashboard (`init --dashboard own` or `none`) can't open, so a leaked
key could never be taken back. An embedded collector does the same when a key's line is deleted from `secrets.json`.
To switch keys without a gap, create the new one in **Settings → API keys** instead. `shardlens keys` says so.
