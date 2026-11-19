---
'@shardlens/collector': patch
---

A server that ran a command and removed the bot within one batch of events (a short-lived install, or events replayed
after an outage) is counted as activated on the Growth page and keeps its last command time. Before, the command was
dropped from the server's record because the removal had already been applied. Commands a user install runs in a
server after the bot was removed are still not counted as that server's.
