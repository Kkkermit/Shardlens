---
'shardlens': patch
---

`shardlens init --force` makes the replaced `.env` and `bot.env` readable by their owner only again, and
`shardlens doctor` says why a request failed (for example `fetch failed (UNABLE_TO_GET_ISSUER_CERT_LOCALLY)`) instead of
only `fetch failed`.
