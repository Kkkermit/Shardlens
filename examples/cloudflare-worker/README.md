# cloudflare-worker

A Discord bot that receives interactions over HTTP on Cloudflare Workers, with Shardlens recording each interaction
through `@shardlens/http`. Events are sent with `ctx.waitUntil`, after the response has gone back to Discord.

```sh
npx wrangler secret put DISCORD_PUBLIC_KEY      # General Information → Public Key
npx wrangler secret put SHARDLENS_INGEST_KEY    # slk_ingest_…
npx wrangler deploy
```

Then set the Worker's URL as the **Interactions Endpoint URL** in the Developer Portal, and register a `/ping` command.
See the [HTTP bots guide](https://kkkermit.github.io/Shardlens/guides/http-bots/).
