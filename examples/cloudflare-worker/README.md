# cloudflare-worker

A Discord bot that receives interactions over HTTP on Cloudflare Workers, with Shardlens recording each interaction
through `@shardlens/http`. Events are sent with `ctx.waitUntil`, after the response has gone back to Discord.

## Deploy

Set your collector's URL as `SHARDLENS_URL` in `wrangler.toml`, then:

```sh
npx wrangler secret put DISCORD_PUBLIC_KEY      # Developer Portal → General Information → Public Key
npx wrangler secret put SHARDLENS_INGEST_KEY    # slk_ingest_…
npx wrangler deploy
```

Set the Worker's URL as the **Interactions Endpoint URL** in the Developer Portal, and register a `/ping` command.
Discord checks the URL with a PING and with a badly signed request; the Worker answers both.

## Run it locally

```sh
cp .dev.vars.example .dev.vars    # fill in the same two values; Git ignores .dev.vars
npx wrangler dev
```

The collector's URL must be HTTPS; only a collector on `http://localhost` may use plain HTTP.

See the [HTTP bots guide](https://kkkermit.github.io/Shardlens/guides/http-bots/) for Deno, Bun and Node.
