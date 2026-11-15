---
'@shardlens/collector': patch
---

Revoking a read key now also signs out the dashboards that signed in with it, and an admin taken off the bot's team
(or removed from `SHARDLENS_EXTRA_ADMINS`) loses access on their next request instead of when their 7-day session
ends. Read-key sessions opened before this upgrade end once, so those dashboards ask for the key again.
