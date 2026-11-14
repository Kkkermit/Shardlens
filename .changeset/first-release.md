---
'@shardlens/schema': minor
'@shardlens/core': minor
'@shardlens/discordjs': minor
'shardlens': minor
'@shardlens/collector': minor
---

First release: privacy-first analytics and health monitoring for discord.js bots. The SDK hashes user IDs in-process,
batches events with retries and never throws into the bot; the discord.js adapter records interactions, REST health,
servers, shards and premium events through public hooks only; the CLI sets up a self-hosted collector.
