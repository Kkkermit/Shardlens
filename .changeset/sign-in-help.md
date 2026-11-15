---
'@shardlens/collector': patch
---

The collector warns at start-up when the bot has no ingest key or nobody could open the dashboard, and Discord sign-in
says when it is refused because the bot hasn't reported its owner and team yet, instead of "not a team member". The
docs no longer call both keys optional.
