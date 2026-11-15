---
'shardlens': minor
---

`shardlens init` also writes `bot.env` with the two settings your bot needs (`SHARDLENS_URL` and the same
`SHARDLENS_INGEST_KEY`), so nothing has to be copied out of the collector's `.env` by hand, and a commented
`SHARDLENS_SINK_URL` for copying events into your own database. `shardlens doctor` reads those two settings from a
`.env` in the folder it runs in when they aren't set, without changing the environment.
