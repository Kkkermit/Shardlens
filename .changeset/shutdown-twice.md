---
'@shardlens/core': patch
'@shardlens/discordjs': patch
---

A second `shutdown()` call waits for the flush the first one started instead of returning at once. With a shard
manager, Ctrl+C sends `SIGINT` from the terminal and then `SIGTERM` from the manager, and the second handler used to
exit the process before the last events were sent.
