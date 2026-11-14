# @shardlens/http

[Shardlens](https://github.com/Kkkermit/Shardlens) for Discord bots that receive interactions over HTTP instead of the
gateway: Cloudflare Workers, Deno, Bun, or Node.js with `@discordjs/core`. Web-standard APIs only.

```sh
npm install @shardlens/http
```

```ts
import { createShardlensHttp } from '@shardlens/http';

const lens = createShardlensHttp({ endpoint: 'https://stats.example.com', apiKey: 'slk_ingest_…' });
const handle = lens.wrapInteractionHandler(async (interaction) => ({ type: 4, data: { content: 'Pong!' } }));

export default {
  async fetch(request: Request, env: unknown, ctx: ExecutionContext) {
    // Verify the request signature first, as Discord requires.
    return Response.json(await handle(await request.json(), ctx));
  },
};
```

Pass anything with `waitUntil` (a Workers `ExecutionContext`, for example) to the wrapped handler and events are sent
after your response, without delaying it. Nothing runs at module scope: no timers and no network until the first
interaction.

## Links

- [HTTP bots guide](https://kkkermit.github.io/Shardlens/guides/http-bots/) ·
  [documentation](https://kkkermit.github.io/Shardlens/) ·
  [what is collected](https://kkkermit.github.io/Shardlens/concepts/data-collected/)
- Using an AI coding agent? Point it at [`llms.txt`](https://kkkermit.github.io/Shardlens/llms.txt), the docs as plain
  text.
- [Source and issues](https://github.com/Kkkermit/Shardlens) · MIT licence · not affiliated with Discord
