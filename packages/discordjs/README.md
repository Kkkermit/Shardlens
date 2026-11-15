# @shardlens/discordjs

Self-hosted, privacy-first analytics and health monitoring for discord.js bots. This is the SDK you add to your bot;
it sends events to a [Shardlens collector](https://kkkermit.github.io/Shardlens/getting-started/quick-start/) that you
run yourself.

- Works with discord.js 14.12 or newer and 15, TypeScript or JavaScript, ESM or CommonJS, Node.js 22.12+.
- Needs the `Guilds` intent only. User IDs are hashed inside your bot; message content is never collected.
- Never throws into your bot: bounded memory, no I/O in listeners, every internal error caught and counted.

```sh
npm install @shardlens/discordjs
```

```ts
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { createShardlens } from '@shardlens/discordjs';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const lens = createShardlens(client, {
  endpoint: process.env.SHARDLENS_URL, // https://stats.example.com
  apiKey: process.env.SHARDLENS_INGEST_KEY, // slk_ingest_…
});

// Optional: record handler time and errors.
client.on(
  Events.InteractionCreate,
  lens.wrap(async (interaction) => {
    // your handler
  }),
);

// The SDK never handles signals: flush on your own shutdown path.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await lens.shutdown();
    await client.destroy();
    process.exit(0);
  });
}

await client.login(process.env.DISCORD_TOKEN);
```

Slash commands, context menus, buttons, select menus, modals and autocomplete are recorded on their own. Prefix
commands are recorded where your parser matches one, with `lens.wrapMessageCommand()` or `lens.trackMessageCommand()`,
and frameworks that run handlers themselves (Sapphire) report through `lens.handlerStarted()` and
`lens.handlerFinished()`.

Create one instance per process: in the shard file with `ShardingManager`, in the cluster file with
discord-hybrid-sharding. See [configuration](https://kkkermit.github.io/Shardlens/getting-started/configuration/),
[command handlers and frameworks](https://kkkermit.github.io/Shardlens/guides/command-handlers/),
[prefix commands](https://kkkermit.github.io/Shardlens/guides/prefix-commands/),
[sharding](https://kkkermit.github.io/Shardlens/guides/sharding/),
[custom events](https://kkkermit.github.io/Shardlens/guides/custom-events/) and the
[`/privacy` command](https://kkkermit.github.io/Shardlens/guides/privacy-command/).

## Links

- [Documentation](https://kkkermit.github.io/Shardlens/) ·
  [what is collected](https://kkkermit.github.io/Shardlens/concepts/data-collected/) ·
  [privacy model](https://kkkermit.github.io/Shardlens/concepts/privacy-model/)
- Using an AI coding agent? Point it at [`install.md`](https://kkkermit.github.io/Shardlens/install.md), a
  self-contained install prompt, or [`llms.txt`](https://kkkermit.github.io/Shardlens/llms.txt), the docs as plain text.
- [Source and issues](https://github.com/Kkkermit/Shardlens) · MIT licence · not affiliated with Discord
