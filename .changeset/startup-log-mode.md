---
'@shardlens/collector': patch
'shardlens': patch
---

The collector's start-up log says which mode users are recorded in (`mode`) and whether `SHARDLENS_MODE` set it
(`modeFrom`), so a log shows that audit mode took effect. The `.env` that `shardlens init` writes no longer says the
dashboard uses the bundled database next to the setting for your own, which read oddly without a dashboard.
