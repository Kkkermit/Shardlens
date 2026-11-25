---
'@shardlens/discordjs': minor
---

`isExpectedError` tells Shardlens which errors your handlers throw on purpose, for a user's mistake your error handler
then explains, such as `(error) => error instanceof UserError`. Those runs count as runs, not failures, so failure
rates show bugs only. The error is still re-thrown to your code.
