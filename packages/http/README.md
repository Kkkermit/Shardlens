# @shardlens/http

Self-hosted, privacy-first analytics for Discord bots that receive interactions over HTTP (an Interactions Endpoint
URL) instead of the gateway: Cloudflare Workers, Deno, Bun, or Node.js with `@discordjs/core`. It sends events to a
[Shardlens collector](https://kkkermit.github.io/Shardlens/getting-started/quick-start/) that you run yourself.

- Web-standard APIs only (`fetch`, Web Crypto, `CompressionStream`): no Node built-ins, one small dependency.
- User IDs are hashed inside your bot. Interaction tokens and what users type never leave it; option values only if
  you list the option in `captureOptionValues`.
- Never changes your answer to Discord, and never throws into your handler.

```sh
npm install @shardlens/http
```

```ts
import { createShardlensHttp, type WaitUntilContext } from '@shardlens/http';
import type { APIInteraction, APIInteractionResponse } from 'discord-api-types/v10';

interface Env {
  SHARDLENS_URL: string; // https://stats.example.com
  SHARDLENS_INGEST_KEY: string; // slk_ingest_…, a secret
}

// Your own check of Discord's Ed25519 signature: the guide has one in ten lines of Web Crypto.
declare function verified(request: Request, body: string): Promise<boolean>;

async function answer(interaction: APIInteraction, _ctx: WaitUntilContext): Promise<APIInteractionResponse> {
  if (interaction.type === 1) return { type: 1 }; // PING: answered, not recorded
  return { type: 4, data: { content: 'Pong!' } };
}

let handle: typeof answer | undefined;

export default {
  async fetch(request: Request, env: Env, ctx: WaitUntilContext): Promise<Response> {
    const body = await request.text();
    if (!(await verified(request, body))) return new Response('Bad request signature', { status: 401 });
    // Created on the first request, when a Worker's secrets arrive. Nothing runs before the first interaction.
    handle ??= createShardlensHttp({
      endpoint: env.SHARDLENS_URL,
      apiKey: env.SHARDLENS_INGEST_KEY,
    }).wrapInteractionHandler(answer);
    return Response.json(await handle(JSON.parse(body) as APIInteraction, ctx));
  },
};
```

`wrapInteractionHandler` records each interaction (command, subcommand, option names, context, locale, response type)
and how long your answer took against Discord's 3-second deadline. A handler that throws is recorded by error class
and throws as before.

- **Cloudflare Workers**: pass `ctx` to the wrapped handler, as above. Events are sent through `ctx.waitUntil`, after
  your response, and nothing depends on a timer outliving the request.
- **Deno, Bun, Node**: without a `waitUntil`, events are batched and sent in the background. Call
  `await lens.shutdown()` when the process stops.

The [HTTP bots guide](https://kkkermit.github.io/Shardlens/guides/http-bots/) has a complete bot for each runtime,
with signature verification, and [`examples/cloudflare-worker`](https://github.com/Kkkermit/Shardlens/tree/main/examples/cloudflare-worker)
is a Worker you can deploy.

## Links

- [HTTP bots guide](https://kkkermit.github.io/Shardlens/guides/http-bots/) ·
  [documentation](https://kkkermit.github.io/Shardlens/) ·
  [what is collected](https://kkkermit.github.io/Shardlens/concepts/data-collected/)
- Using an AI coding agent? Point it at [`http.md`](https://kkkermit.github.io/Shardlens/prompts/http.md), a self-contained prompt for adding this package,
  or [`llms.txt`](https://kkkermit.github.io/Shardlens/llms.txt), the docs as plain text.
- [Source and issues](https://github.com/Kkkermit/Shardlens) · MIT licence · not affiliated with Discord
