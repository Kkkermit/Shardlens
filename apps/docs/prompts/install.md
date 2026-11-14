# Add Shardlens to this Discord bot

You are adding Shardlens to the discord.js bot in this repository. Everything you need is in this prompt; you don't need web access. Work through the steps in order, read before you edit, change as little as possible, and match the project's existing style (TypeScript or JavaScript, ESM or CommonJS, formatting).

## What Shardlens is

Shardlens is self-hosted, privacy-first analytics and health monitoring for discord.js bots (MIT).

- It has two parts: an **SDK** inside the bot (`@shardlens/discordjs`, what you are installing) and a **collector** with a dashboard that the bot's owner runs separately. The SDK sends batches of events to the collector over HTTPS.
- The SDK records interactions (command name, outcome, response time), servers joined and left, REST and shard health. It never records message content, and user IDs are hashed inside the bot before anything is sent.
- It listens through public discord.js events only. It does not change how the bot behaves, never throws into the bot, and needs no Gateway intent beyond `Guilds`.
- Requirements: discord.js 14 or 15, Node.js 22.12 or newer. It ships ESM and CommonJS builds with types.

Repository: https://github.com/Kkkermit/Shardlens · Docs: https://kkkermit.github.io/Shardlens/

## 1. Look at the project first

- `package.json` and the lockfile: which package manager is used, which discord.js version is installed, and which Node.js version the project targets.
- Whether the code is TypeScript or JavaScript, and ESM (`import`) or CommonJS (`require`).
- Where the discord.js `Client` is constructed and where `client.login()` is called.
- How the bot runs: one process, `ShardingManager` (find the shard file it spawns), internal sharding (`shards: 'auto'`), or discord-hybrid-sharding (`ClusterManager` and `ClusterClient`).
- Where interactions are handled (the `interactionCreate` listener or a command dispatcher).
- How environment variables are loaded, and whether the bot already handles `SIGINT`/`SIGTERM`.

Stop and tell me, instead of continuing, if:

- discord.js is older than 14 or Node.js is older than 22.12 (don't upgrade them yourself);
- the bot has no gateway `Client` and receives interactions over HTTP (Cloudflare Workers, Deno, Bun, or `@discordjs/core` with an Interactions Endpoint URL). That bot needs `@shardlens/http` instead: https://kkkermit.github.io/Shardlens/guides/http-bots/

## 2. Install the SDK

Install `@shardlens/discordjs` with the project's own package manager. Don't add any other dependency.

If the registry answers that the package doesn't exist, stop and tell me: Shardlens may not be published yet. Never install it from a tarball, a fork or a similarly named package.

## 3. Create Shardlens next to the client

In the file that constructs the `Client`, after the client exists and before `client.login()`:

```ts
import { createShardlens } from '@shardlens/discordjs';

const lens = createShardlens(client, {
  endpoint: process.env.SHARDLENS_URL,
  apiKey: process.env.SHARDLENS_INGEST_KEY,
});
```

In CommonJS, use `const { createShardlens } = require('@shardlens/discordjs');`.

- Call it exactly once per process.
- **`ShardingManager`:** put it in the shard file (the one that constructs the `Client`), never in the manager file.
- **discord-hybrid-sharding:** put it in the cluster file, after `client.cluster = new ClusterClient(client)` has been set. Never in the `ClusterManager` file.
- **Internal sharding** (`shards: 'auto'`) and single-process bots need nothing special.
- Make `lens` reachable from wherever interactions are handled, the same way the project already shares its client (an export, a property on the client, a container).
- If the project has its version readily available (for example from `package.json`), pass it as `release`.
- If either variable is unset, the SDK logs one warning and records nothing; `lens.wrap()` and every other call still work and do nothing. The bot must still start, so don't add your own checks and don't throw.

## 4. Wrap the interaction handler

`lens.wrap(handler)` takes a function whose first argument is the interaction and returns a function with the same arguments. It records how long the handler took and any error it threw, then re-throws the error unchanged, so the project's own error handling still runs.

Wrap at the single place interactions are dispatched, not in every command file:

```ts
import { Events } from 'discord.js';

client.on(
  Events.InteractionCreate,
  lens.wrap(async (interaction) => {
    // the existing handler body, unchanged
  }),
);
```

If the project routes commands through its own dispatcher, wrap that function instead:

```ts
import type { ChatInputCommandInteraction } from 'discord.js';

const runCommand = lens.wrap(async (interaction: ChatInputCommandInteraction) => {
  // `commands` stands for the project's own command registry
  await commands.get(interaction.commandName)?.execute(interaction);
});
```

`wrap` only sees an error that leaves the function it wraps. If the project already catches command errors (a `try`/`catch` around the command call, to reply "something went wrong"), wrapping the whole listener records nothing as failed. Wrap the function that is called inside the `try` instead, and leave the project's `catch` as it is:

```ts
import { Events, type ChatInputCommandInteraction } from 'discord.js';

const execute = lens.wrap(async (interaction: ChatInputCommandInteraction) => {
  await commands.get(interaction.commandName)?.execute(interaction);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  try {
    await execute(interaction);
  } catch (error) {
    // the project's existing error reply, unchanged
  }
});
```

Interactions are recorded even without `wrap`; wrapping adds handler time and handler errors.

## 5. Flush on shutdown

The SDK never installs signal handlers. On the bot's existing shutdown path, `await lens.shutdown()` before the client is destroyed or the process exits. If the bot has no shutdown handling, add it:

```ts
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await lens.shutdown();
    await client.destroy();
    process.exit(0);
  });
}
```

`shutdown()` gives up after 2 seconds and never throws.

## 6. Document the two settings

Add `SHARDLENS_URL=` and `SHARDLENS_INGEST_KEY=` (empty) to `.env.example` or wherever the project documents its environment, and to its environment validation or types if it has any. Add one line about Shardlens to the README's setup section if there is one.

- `SHARDLENS_URL` is the collector's address, for example `https://stats.example.com`. It must be HTTPS (plain HTTP is accepted for `localhost` only).
- `SHARDLENS_INGEST_KEY` looks like `slk_ingest_…`. It can only send events; it cannot read anything.

## Rules

- Never write a real key, token or URL with credentials into a tracked file, and never log one.
- Don't add or change Gateway intents. Shardlens must never be the reason a privileged intent is enabled.
- Leave privacy mode on: don't set `mode: 'audit'` or `captureOptionValues` unless I ask.
- Don't wrap SDK calls (`createShardlens`, `lens.*`) in `try`/`catch`: the SDK never throws into the bot.
- Don't change command behaviour, error handling or anything unrelated to these steps.

## Only if I ask for them

**Custom events.** Names are lower snake case; properties are small strings, numbers, booleans or nulls. Never put a user ID, a username or message text in the properties. Pass the user as context, where it is hashed:

```ts
lens.track('ticket_opened', { category: 'billing' }, { userId: interaction.user.id, guildId: interaction.guildId });
```

**A `/privacy` command** that lets users see what is collected, opt out and ask for erasure:

```ts
import { createPrivacyCommand } from '@shardlens/discordjs';

const privacy = createPrivacyCommand(lens, { policyUrl: 'https://example.com/privacy' });
// Register `privacy.data` with the project's other commands, then, at the top of the interaction handler:
if (interaction.isChatInputCommand() && (await privacy.handle(interaction))) {
  // handled
}
```

**Embedded mode**, for a small bot on one host with no separate collector. It needs Node.js 24.11 or newer. Install `@shardlens/collector` and `@electric-sql/pglite` as well, add the data folder to `.gitignore`, document `DISCORD_APP_ID` (the application ID from the Developer Portal) next to the bot's other settings, and use the collector's own address and key instead of the two environment variables:

```ts
import { startEmbeddedCollector } from '@shardlens/collector/embedded';
import { createShardlens } from '@shardlens/discordjs';

// Unlike the SDK, the embedded collector can fail to start: a port in use, a folder it can't write to, a missing
// application ID. Catch that, so the bot starts without analytics instead of not starting.
const collector = await startEmbeddedCollector({
  dataDir: './shardlens-data',
  appId: process.env.DISCORD_APP_ID ?? '',
  port: 8080,
}).catch((error: unknown) => {
  console.error('Shardlens: the embedded collector did not start.', error);
  return undefined;
});
const lens = createShardlens(client, { endpoint: collector?.url, apiKey: collector?.ingestKey });
```

This uses top-level `await`, which needs an ES module; in CommonJS, put it inside the `async` function that starts the bot. On shutdown, after `await lens.shutdown()`, also `await collector?.close()`. The dashboard is then at `http://127.0.0.1:8080`, and the key to sign in with is `readKey` in `shardlens-data/secrets.json`: tell me where it is, never print it.

**Other options** of `createShardlens`: `environment` (default `'production'`), `dryRun` (print events instead of sending them), `disable` (turn off groups: `'interactions'`, `'guilds'`, `'rest'`, `'gateway'`, `'process'`, `'premium'`, `'app'`), `optedOut` and `onOptOutChange` (persist opt-outs), `spool: { dir }` (keep events on disk through long collector outages), `exporters` (Prometheus or OpenTelemetry), `sampleRate` (very large bots). Every option is documented in the package's type definitions (`node_modules/@shardlens/discordjs/dist/index.d.ts`).

## Check your work

- Run the project's own type-check, lint, build and test scripts, and fix anything you broke.
- If `SHARDLENS_URL` and `SHARDLENS_INGEST_KEY` are set in my environment, run `npx shardlens doctor` from the bot's folder and show me its output. It checks Node.js, discord.js, the collector and the key. Never print the key.
- Don't start the bot yourself unless I ask.

## Tell me when you're done

- Which files you changed, and what each change does.
- What I still need to do:
  1. Run a collector: `npx shardlens init --domain <my domain> --app-id <my application ID>`, then `docker compose up -d` in the folder it creates. It prints nothing secret; the keys are in the generated `.env`. Guide: https://kkkermit.github.io/Shardlens/getting-started/quick-start/
  2. Set `SHARDLENS_URL` and `SHARDLENS_INGEST_KEY` where the bot runs.
  3. To see what would be sent before any of that, pass `dryRun: true` once and run a command in the bot.
- Anything you skipped or weren't sure about.

## If you need more

The whole documentation is available as plain text for agents: an index at https://kkkermit.github.io/Shardlens/llms.txt and everything in one file at https://kkkermit.github.io/Shardlens/llms-full.txt. The collector's HTTP API, as an OpenAPI document: https://kkkermit.github.io/Shardlens/openapi.json. What is collected, field by field: https://kkkermit.github.io/Shardlens/concepts/data-collected/
