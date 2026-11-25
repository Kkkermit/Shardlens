---
'@shardlens/collector': minor
---

A dashboard started from a terminal or inside a bot signs its owner in with a one-time link: each works once, within
15 minutes, and gives the owner's rights, settings included (whoever can see the link already holds the database).
Collectors started from the image or with `startEmbeddedCollector` don't offer links. A new migration allows these
sessions in PostgreSQL.
