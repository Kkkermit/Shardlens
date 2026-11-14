# @shardlens/core

The library-agnostic core of the [Shardlens](https://github.com/Kkkermit/Shardlens) SDK: a bounded priority queue,
in-process user hashing, gzip batching, retries, secret redaction and the exporter hook. Zero runtime dependencies and
Web-standard APIs only, so it runs on Node.js 22.12+, Bun, Deno and Cloudflare Workers.

You normally don't install this directly:

- for a gateway bot, use [`@shardlens/discordjs`](https://www.npmjs.com/package/@shardlens/discordjs);
- for an HTTP-interaction bot, use [`@shardlens/http`](https://www.npmjs.com/package/@shardlens/http).

Depend on core to write an adapter for another library or your own metrics exporter (`ShardlensExporter`).

## Links

- [Documentation](https://kkkermit.github.io/Shardlens/) ·
  [architecture](https://kkkermit.github.io/Shardlens/concepts/architecture/) ·
  [privacy model](https://kkkermit.github.io/Shardlens/concepts/privacy-model/)
- Using an AI coding agent? Point it at [`llms.txt`](https://kkkermit.github.io/Shardlens/llms.txt), the docs as plain
  text.
- [Source and issues](https://github.com/Kkkermit/Shardlens) · MIT licence · not affiliated with Discord
