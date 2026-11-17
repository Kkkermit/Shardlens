---
'@shardlens/collector': minor
---

Live streams (`/v1/live`) send a heartbeat comment every 15 seconds, whatever the database does. A reader can tell a
quiet stream from a connection that died without either end closing it, and proxies that close idle connections keep
the stream open. `@shardlens/client`'s `live()` gives up on a stream that sends nothing for 45 seconds.
