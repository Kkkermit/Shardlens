---
'@shardlens/core': minor
'@shardlens/http': minor
---

New `@shardlens/http` package for bots that receive interactions over HTTP (Cloudflare Workers, Deno, Bun,
`@discordjs/core`). `createShardlensHttp(options).wrapInteractionHandler(handler)` records each interaction with the
same fields as the discord.js adapter, times the answer against the 3-second deadline and sends events through
`waitUntil` when the runtime provides it. Core gains `client.idle()` to wait for salts and hashing before a flush.
