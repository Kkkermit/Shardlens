---
'@shardlens/collector': minor
'@shardlens/discordjs': minor
'shardlens': minor
---

`mongodb: { uri, database }` keeps Shardlens's collections in a database of your choice, for a database user allowed
into one database only (`npx shardlens dashboard --database` reads the same). Each bot process opens at most 5
connections (10 while it serves the dashboard), unless the connection string sets `maxPoolSize`.
