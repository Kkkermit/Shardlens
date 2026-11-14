---
'@shardlens/discordjs': minor
---

Support discord.js 15 alongside 14. Shard IDs, pings and shard lifecycle events are read through whichever public API
the installed version has (v15 moved them to `client.ws`, the `@discordjs/ws` manager), and the `/privacy` command
is plain command JSON now that discord.js 15 no longer re-exports the builders. A nightly CI job runs the adapter
tests against `discord.js@latest` and `@dev`.
