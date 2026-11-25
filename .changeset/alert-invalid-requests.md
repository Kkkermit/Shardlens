---
'@shardlens/collector': patch
---

An alert on the invalid-request share (`invalid_requests_pct`) no longer stops the alert job when it fires. The value
came back from PostgreSQL as text, formatting it for the Discord message threw, and the rules after it in that run
were not checked.
