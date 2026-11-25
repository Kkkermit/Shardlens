# @shardlens/discordjs

Self-hosted, privacy-first analytics and health monitoring for discord.js bots. This is the SDK you add to your bot.
It keeps everything in the MongoDB your bot already uses, with nothing else to run, or sends events to a
[Shardlens collector](https://kkkermit.github.io/Shardlens/getting-started/quick-start/) on a server of yours.

- Works with discord.js 14.12 or newer and 15, TypeScript or JavaScript, ESM or CommonJS, Node.js 22.12+.
- Needs the `Guilds` intent only. User IDs are hashed inside your bot; message content is never collected.
- Never throws into your bot: bounded memory, no I/O in listeners, every internal error caught and counted.

```sh
npm install @shardlens/discordjs @shardlens/collector
```

```ts
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { createShardlens } from '@shardlens/discordjs';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
// Your bot's own MongoDB. With a collector on a server instead: { endpoint, apiKey }, and no @shardlens/collector.
const lens = createShardlens(client, { mongodb: process.env.MONGODB_URI });

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

Then run `npx shardlens dashboard` in your bot's folder to open the dashboard
([on your MongoDB](https://kkkermit.github.io/Shardlens/self-hosting/mongodb/)).

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
