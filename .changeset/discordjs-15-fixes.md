---
'@shardlens/discordjs': patch
'@shardlens/schema': patch
---

Fixes from a simulated install on a discord.js 15 development build:

- npm installs the adapter next to discord.js 15 development builds: the peer range is `^14.0.0 || ^15.0.0-0`.
- A fatal gateway error on discord.js 15 (an invalid token on re-identify, say) crashes the bot as it does without
  Shardlens. The adapter's `error` listener on `client.ws` used to swallow it and leave the bot running, disconnected.
- With `ShardingManager` on discord.js 15, whose `client.shard` has no `ids`, events are tagged with the process's
  shards again, and the startup work (server snapshot, application info, command list) runs.
- After a fresh gateway session, the server snapshot comes from Discord's READY list instead of the cache, so servers
  removed while the shard was away are found (the cache keeps them), and on discord.js 15 servers added meanwhile too.
- On discord.js 15, a shard's ready state no longer reports every server as unavailable.
