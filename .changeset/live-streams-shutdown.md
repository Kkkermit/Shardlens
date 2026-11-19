---
'@shardlens/collector': patch
---

The collector stops while live streams are open. Closing waited for every open `/v1/live` stream, which never ends on
its own, so a collector with the Overview page (or a `live()` reader) open didn't exit on `SIGTERM`, and
`collector.close()` of an embedded collector kept the bot running. Open streams are now ended on shutdown, and readers
see the stream end.
