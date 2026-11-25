# Add Shardlens to this HTTP-interaction bot

You are adding `@shardlens/http` to a Discord bot that receives interactions over HTTP (an Interactions Endpoint URL)
instead of the gateway: on Cloudflare Workers, Deno, Bun, or Node with `@discordjs/core`. Shardlens is privacy-first
analytics for Discord bots (MIT). Everything you need is here; you don't need web access. Read before you edit, change
as little as possible and match the project's style. If the bot has a discord.js gateway `Client`, stop: it needs
`@shardlens/discordjs` and https://kkkermit.github.io/Shardlens/install.md instead.

## Install and wrap

Install `@shardlens/http` with the project's package manager (`deno add npm:@shardlens/http` on Deno). It uses
Web-standard APIs only, starts nothing until the first interaction, and never throws into the bot.

Find the one function that turns a verified interaction into its response, and wrap it where it is called:

```ts
import { createShardlensHttp, type WaitUntilContext } from '@shardlens/http';
import type { APIInteraction, APIInteractionResponse } from 'discord-api-types/v10';

// `answer` stands for the project's own handler: called the same way, its result returned unchanged.
declare function answer(interaction: APIInteraction, ctx?: WaitUntilContext): Promise<APIInteractionResponse>;
declare const env: { SHARDLENS_URL?: string; SHARDLENS_INGEST_KEY?: string };

const lens = createShardlensHttp({ endpoint: env.SHARDLENS_URL, apiKey: env.SHARDLENS_INGEST_KEY });
export const handle = lens.wrapInteractionHandler(answer);
```

- **Cloudflare Workers:** pass the request's `ctx` through to the wrapped handler: Shardlens sends each request's events
  with `ctx.waitUntil`, after the response. Create `lens` with the first request, where the secrets arrive.
- **A long-running server** (Node, Bun, Deno): events go every 5 seconds; call `await lens.shutdown()` on the project's
  shutdown path.
- **Serverless without `waitUntil`:** `await lens.flush()` before returning.

Keep the signature check the project already has. Pass `release` if the project has its version at hand.

## Settings

Two, as optional strings in wherever the project keeps settings and secrets (Worker secrets for the key):
`SHARDLENS_URL`, the collector's address, and `SHARDLENS_INGEST_KEY` (`slk_ingest_…`). The collector runs on a server
(`npx shardlens init`, or the collector image on the MongoDB a bot already uses): this package can't run one itself.
Without the settings, the SDK warns once and records nothing.

## Rules

Never log or commit the key; don't add per-user tracking; don't send message content or option values (only options
listed in `captureOptionValues` are recorded).

## Tell me when you're done

The files you changed, the two settings and where to set them, and how to see the first events. Guide:
https://kkkermit.github.io/Shardlens/guides/http-bots/
