# Add Shardlens to this Discord bot

You are adding Shardlens to the discord.js bot in this repository. Everything you need is in this prompt; you don't need web access. Work through the steps in order, read before you edit, change as little as possible, and match the project's existing style (TypeScript or JavaScript, ESM or CommonJS, formatting). The samples below are TypeScript; in JavaScript, leave out the types, and in CommonJS use `require` instead of `import`.

## What Shardlens is

Shardlens is self-hosted, privacy-first analytics and health monitoring for discord.js bots (MIT).

- It has two parts: an **SDK** inside the bot (`@shardlens/discordjs`, what you are installing) and a **collector** that stores events and serves the dashboard. If the bot already uses MongoDB, the collector runs inside the bot on that same database (the SDK's `mongodb` option): nothing else to run, and this is what you set up. Otherwise the owner runs the collector on a server (or inside the bot in embedded mode), and the SDK sends it batches of events over HTTPS.
- The dashboard is the owner's choice, and the SDK is the same for all three: the Shardlens dashboard (the default), a dashboard they already have (it reads every number through `@shardlens/client`), or none. If I haven't said which I want, assume the Shardlens dashboard and ask me at the end; don't build anything for the other two unless I ask.
- The SDK records interactions (command name, outcome, response time), prefix commands the bot reports, servers joined and left, REST and shard health. It never records message content, and user IDs are hashed inside the bot before anything is sent.
- It listens through public discord.js events only. It does not change how the bot behaves, never throws into the bot, and needs no Gateway intent beyond `Guilds`.
- Requirements: discord.js 14.12 or newer, or 15; Node.js 22.12 or newer (the same for every setup, the collector inside the bot included). On MongoDB, the server must be 7.0 or newer (Atlas runs 8.0); the bot's own driver or mongoose version doesn't matter. It ships ESM and CommonJS builds with types.

Repository: https://github.com/Kkkermit/Shardlens · Docs: https://kkkermit.github.io/Shardlens/

## 1. Look at the project first

- `package.json` and the lockfile: which package manager is used, which discord.js version is installed, and which Node.js version the project targets.
- Whether the code is TypeScript or JavaScript, and ESM (`import`) or CommonJS (`require`). TypeScript built to CommonJS (tsc, tsup, esbuild) counts as CommonJS for imports at runtime; write what the project's own source files use.
- Where the discord.js `Client` is constructed (it may be a subclass, or a framework's client such as `SapphireClient` or discordx's `Client`) and where `client.login()` is called, and whether that happens at the top level of a module or inside an `async` function.
- How the bot runs: one process, `ShardingManager` (find the shard file it spawns), internal sharding (`shards: 'auto'`), or discord-hybrid-sharding (`ClusterManager` and `ClusterClient`).
- How commands are registered and run: the discord.js guide layout (a `commands/` folder of files with `execute`, and an `interactionCreate` file), a framework (Sapphire, discordx, CommandKit, Necord), or a loader the project wrote. Find the one place a matched command's code is called.
- Whether the bot has prefix (message) commands: a `messageCreate` listener that checks a prefix or a mention, or a framework's message commands. Note whether the prefix comes from a database, whether there are aliases, and whether slash and prefix commands share the same command code.
- Whether that code already catches command errors itself (a `try`/`catch` that replies "something went wrong").
- How environment variables and settings are loaded (a `.env` file, a config file, a validation schema), and whether the bot already handles `SIGINT`/`SIGTERM`.
- Whether the bot uses MongoDB (`mongodb` or `mongoose` in its dependencies), and the name of the setting that holds its connection string (`MONGODB_URI`, `MONGO_URL`, `DATABASE_URL`, a field of a config file, …). Never print its value. If it does, set Shardlens up on that database: the MongoDB variant below, whatever the bot's Node.js version, as long as it is 22.12 or newer. You can't check the MongoDB server's version from here: assume it is 7.0 or newer, and mention it at the end.

Stop and tell me, instead of continuing, if:

- discord.js is older than 14.12 or Node.js is older than 22.12 (don't upgrade them yourself);
- the bot has no gateway `Client` and receives interactions over HTTP (Cloudflare Workers, Deno, Bun, or `@discordjs/core` with an Interactions Endpoint URL). That bot needs `@shardlens/http` instead: https://kkkermit.github.io/Shardlens/guides/http-bots/

## 2. Install the SDK

Install `@shardlens/discordjs` with the project's own package manager, and on MongoDB `@shardlens/collector` too. Don't add any other dependency (embedded mode, below, adds two more, and my own dashboard adds `@shardlens/client`, only if I asked for them). If the project commits a lockfile, commit the updated one; if it has none, don't add one.

If the registry answers that the package doesn't exist, stop and tell me: Shardlens may not be published yet. Never install it from a tarball, a fork or a similarly named package.

## 3. Create Shardlens next to the client

In the file that constructs the `Client`, after the client exists and before `client.login()`. **On MongoDB**, pass the connection string the bot already reads, from the same place it reads it (here `MONGODB_URI`; use the project's own name, never a hard-coded string):

```ts
import { createShardlens } from '@shardlens/discordjs';

const lens = createShardlens(client, { mongodb: process.env.MONGODB_URI });
```

Shardlens adds its own collections (prefixed `shardlens_`) and never touches the bot's. It connects with its own client: don't pass it the bot's mongoose or MongoDB connection object, and don't change how the bot connects. Pass the connection string only: Shardlens keeps its collections in the database the string names, or in one called `shardlens` when it names none, even if the bot picks its own database with a separate setting (that's fine; don't build a URL for it). If the project validates its settings (zod, a config module), read the string from there, as the bot does. **With a collector** instead (no MongoDB):

```ts
import { createShardlens } from '@shardlens/discordjs';

const lens = createShardlens(client, {
  endpoint: process.env.SHARDLENS_URL,
  apiKey: process.env.SHARDLENS_INGEST_KEY,
});
```

In CommonJS, use `const { createShardlens } = require('@shardlens/discordjs');`.

- Call it exactly once per process. On MongoDB that is still once per process: every process of a sharded bot writes to the same database.
- **`ShardingManager`:** put it in the shard file (the one that constructs the `Client`), never in the manager file.
- **discord-hybrid-sharding:** put it in the cluster file, after `client.cluster = new ClusterClient(client)` has been set. Never in the `ClusterManager` file.
- **Internal sharding** (`shards: 'auto'`) and single-process bots need nothing special.
- Make `lens` reachable from wherever interactions and messages are handled, the same way the project already shares things (an export, a container). If it has no such pattern, put it on the client (`client.lens = createShardlens(…)`; in TypeScript add `lens: Shardlens` to the project's existing `declare module 'discord.js' { interface Client { … } }`, or add that declaration), so every handler reaches it as `interaction.client.lens` or `message.client.lens`.
- Pass the bot's version as `release` if the project already has it at hand (a constant, or a `package.json` it already reads). Otherwise pass `release: process.env.npm_package_version`: npm sets it when the bot is started with `npm start` or another npm script, shard and cluster processes inherit it, and it is simply left out when the bot is started with plain `node`. Don't add a JSON import the project's build doesn't already allow.
- If its setting is unset (the connection string on MongoDB; the URL or the key with a collector), the SDK logs one warning in each process and records nothing; `lens.wrap()` and every other call still work and do nothing. The bot must still start, so don't add your own checks and don't throw. On MongoDB the SDK also never throws when the database is down: events wait in memory and arrive when it is back.

## 4. Wrap the interaction handler

`lens.wrap(handler)` takes a function whose first argument is the interaction and returns a function with the same arguments. It records how long the handler took and any error it threw, then re-throws the error unchanged, so the project's own error handling still runs.

Wrap where the project calls its handlers, not in every command file: the place matched commands are called, and likewise where it calls autocomplete, button, select menu and modal handlers if it dispatches those to code of its own. Call each wrapped function exactly where and how the original was called: inside the same `try`, awaited only if the original was awaited. If the listener is already `async`, wrap the whole listener; if it isn't (it calls the handler without `await`), wrap the function it calls instead, because an `async` listener's failures go to the client's `error` event:

```ts
import { Events } from 'discord.js';

client.on(
  Events.InteractionCreate,
  lens.wrap(async (interaction) => {
    // the existing handler body, unchanged
  }),
);
```

`wrap` only sees an error that leaves the function it wraps. If the project already catches command errors (a `try`/`catch` around the command call, to reply "something went wrong"), wrapping the whole listener records nothing as failed. Wrap the call inside the `try` instead, and leave the project's `catch` as it is:

```ts
import { type ChatInputCommandInteraction, Events } from 'discord.js';

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  // `commands` stands for the project's own command registry
  const command = commands.get(interaction.commandName);
  if (!command) return;
  try {
    await lens.wrap((i: ChatInputCommandInteraction) => command.execute(i))(interaction);
  } catch (error) {
    // the project's existing error reply, unchanged
  }
});
```

Creating the wrapper on each call, as here, is cheap. With `lens` on the client it reads `interaction.client.lens.wrap(…)`, which also works when `lens` is created after the listeners are registered (in embedded mode, below).

- If one listener handles several kinds of interaction with a `try` each, wrap the call inside each `try`. Wrapped calls may sit inside one another (a wrapped router calling a wrapped command, a framework's wrap around yours): the outermost is timed and the first error any of them throws is kept, so nesting is harmless.
- In TypeScript, a check on a property (`if (!command.autocomplete) return;`) doesn't narrow inside the arrow you pass to `wrap`. Take it into a constant first (`const run = command.autocomplete;`) and call `run(i)`.
- Every error that leaves the wrapped function counts as a failed run, including ones the bot throws on purpose for a user's mistake (a validation error it then explains). If the project has such errors, wrap only the handler, and mention at the end that they will show as failures. Checks that refuse a command before it runs (permissions, cooldowns, guild-only) stay outside the wrapped call: those runs are recorded, without a handler time or a failure.

Interactions are recorded even without `wrap`; wrapping adds handler time and handler errors. If one function runs both slash and prefix commands, wrapping it is still right: `wrap` records the interactions it is given and runs anything else untouched.

**If a framework runs the handlers** and emits events when a command starts and ends (Sapphire does), there is nothing to wrap. Report from those events instead, with `lens.handlerStarted(interaction)` and `lens.handlerFinished(interaction, { durationMs, error })`. For Sapphire:

```ts
import { Events } from '@sapphire/framework';

client.on(Events.ChatInputCommandRun, (interaction) => lens.handlerStarted(interaction));
client.on(Events.ChatInputCommandSuccess, ({ interaction, duration }) =>
  lens.handlerFinished(interaction, { durationMs: duration }),
);
client.on(Events.ChatInputCommandError, (error, { interaction, duration }) =>
  lens.handlerFinished(interaction, { durationMs: duration, error }),
);
// Prefix commands, from the same framework:
client.on(Events.MessageCommandSuccess, ({ message, command, duration }) =>
  lens.trackMessageCommand(message, { command: command.name, durationMs: duration }),
);
client.on(Events.MessageCommandError, (error, { message, command, duration }) =>
  lens.trackMessageCommand(message, { command: command.name, durationMs: duration, error }),
);
```

Sapphire's context-menu events (`ContextMenuCommandRun`, `ContextMenuCommandSuccess`, `ContextMenuCommandError`) work the same way.

**If a framework runs every command through middleware** (discordx's global guards, CommandKit middleware, Necord interceptors), wrap the framework's `next()` there, once, for both kinds of command:

```ts
import { BaseInteraction, type Message } from 'discord.js';

// What the framework hands its middleware: the interaction or the message, the matched command's own name, and
// `next`, which runs the command.
async function shardlensMiddleware(run: BaseInteraction | Message, commandName: string, next: () => Promise<unknown>) {
  if (run instanceof BaseInteraction) await lens.wrap((_i: BaseInteraction) => next())(run);
  else await lens.wrapMessageCommand(commandName, (_m: Message) => next())(run);
}
```

With discordx, that is a `GuardFunction` from `discordx` added in front of the client's others (`client.guards = [guard, ...client.guards]`): its first argument is either an interaction or a `SimpleCommandMessage`, whose command name is `arg.info.name` and whose message is `arg.message`; for anything else (an event), just `await next()`. Then leave `executeInteraction` and `executeCommand` as they are.

### Prefix commands, if the bot has them

Skip this if the bot has no message commands, or if a framework already reports them (above). Prefix commands (`!ban @someone`, or a mention of the bot followed by a command) are ordinary messages, so Shardlens can't see them on its own, and it never reads message content. Tell it at the single place the project runs a prefix command, after the project's own parser has found the command. Wrap the call, inside the project's `try` if there is one, like `wrap` for interactions:

```ts
import type { Message } from 'discord.js';

async function runPrefixCommand(message: Message, name: string, args: string[]) {
  // `prefixCommands` stands for the project's own registry of message commands
  const command = prefixCommands.get(name);
  if (!command) return;
  try {
    // The command's own name, after aliases: never the text that was typed.
    await lens.wrapMessageCommand(command.name, (m: Message) => command.execute(m, args))(message);
  } catch {
    // the project's existing error reply, unchanged
  }
}
```

Where a wrapper doesn't fit the code (the run ends in a callback, or only the project's `catch` knows it failed), report the run once it is over:

```ts
import type { Message } from 'discord.js';

async function runPrefixCommand(message: Message, name: string, args: string[]) {
  const command = prefixCommands.get(name);
  if (!command) return;
  const started = performance.now();
  let failed = false;
  try {
    await command.execute(message, args);
  } catch {
    failed = true;
    // the project's existing error reply, unchanged
  }
  lens.trackMessageCommand(message, { command: command.name, durationMs: performance.now() - started, failed });
}
```

If each command catches its own errors, so that nothing leaves it, either form records every run and its duration, but as a success. Don't edit every command for it: say so in your summary.

- If the command has a subcommand, pass `{ command, sub }` to `wrapMessageCommand` or add `sub` to the `trackMessageCommand` object.
- Pass the command's own name after the project's parser has matched it (aliases resolved, prefix removed). A per-server prefix from a database, aliases and mentions make no difference.
- Only record what the parser matched: a message that isn't a known command must not be recorded, and checks that refuse to run a command (server only, missing permission) can stay outside the wrapped call.
- Never pass `message.content`, the typed name, argument values or anything else the user wrote.
- Record prefix commands only with `trackMessageCommand` or `wrapMessageCommand`, never as a custom event with `track()`: only those show up next to slash commands.
- Don't add the Message Content intent for Shardlens. If the bot has prefix commands it already has it.

## 5. Flush on shutdown

The SDK never installs signal handlers. On the bot's existing shutdown path, `await lens.shutdown()` before the client is destroyed or the process exits. If the bot has no shutdown handling, add it in the file that creates `lens`:

```ts
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await lens.shutdown();
    await client.destroy();
    process.exit(0);
  });
}
```

`shutdown()` gives up after 2 seconds and never throws, so it needs no `try` of its own: put it before the existing steps, outside any `try` they have. If the project registers shutdown hooks that run in reverse order, register Shardlens's after the one that destroys the client, so it runs first. Calling it a second time waits for the same flush. On MongoDB it also closes Shardlens's own database connection; the bot's stays as it was.

**With `ShardingManager` or discord-hybrid-sharding**, that handler goes in the shard or cluster file. A signal sent to the manager alone (`docker stop`, systemd, a host's restart) never reaches those processes: they keep running, and are killed without flushing when the container or service stops. So also add this to the manager file, before `spawn()`. If the manager already has a signal handler that stops each shard or cluster and waits for it to exit, it is enough: leave it as it is. For `ShardingManager`:

```ts
import { once } from 'node:events';
import type { ShardingManager } from 'discord.js';

declare const manager: ShardingManager; // the project's own manager

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await Promise.all(
      manager.shards.map((shard) => {
        const child = shard.process;
        if (!child || child.exitCode !== null) return undefined;
        shard.kill(); // SIGTERM to the shard, which then flushes and exits
        return once(child, 'exit');
      }),
    );
    process.exit(0);
  });
}
```

For discord-hybrid-sharding's `ClusterManager` (in `mode: 'process'`, the default):

```ts
import { once } from 'node:events';
import { Child, type ClusterManager } from 'discord-hybrid-sharding';

declare const manager: ClusterManager; // the project's own manager

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await Promise.all(
      [...manager.clusters.values()].map((cluster) => {
        const child = cluster.thread instanceof Child ? cluster.thread.process : null;
        if (!child || child.exitCode !== null) return undefined;
        cluster.kill({ force: true, reason: signal });
        // After kill(), which removes the child's listeners: one added before it would never hear the exit.
        return once(child, 'exit');
      }),
    );
    process.exit(0);
  });
}
```

## 6. Document the setup

**On MongoDB** there is no new setting. Add one line about Shardlens to the README's setup section if there is one, for example: "Analytics: [Shardlens](https://kkkermit.github.io/Shardlens/), stored in this bot's MongoDB (collections prefixed `shardlens_`). Run `npx shardlens dashboard` to see them." In embedded mode, skip this step.

**With a collector:**

Add `SHARDLENS_URL=` and `SHARDLENS_INGEST_KEY=` (empty) to `.env.example` or wherever the project documents its environment. If the project validates its environment (zod, envalid, a config file), declare both as **optional strings and nothing more**: no format checks, no "both or neither" rule, no failure. The SDK checks them itself, logs one warning and records nothing when they are wrong. Add one line about Shardlens to the README's setup section if there is one.

- `SHARDLENS_URL` is the collector's address, for example `https://stats.example.com`. It must be HTTPS (plain HTTP is accepted for `localhost` only).
- `SHARDLENS_INGEST_KEY` looks like `slk_ingest_…`. It can only send events; it cannot read anything.

## Rules

- Never write a real key, token or URL with credentials into a tracked file, and never log one.
- Don't add or change Gateway intents. Shardlens must never be the reason a privileged intent is enabled.
- Leave privacy mode on: don't set `mode: 'audit'` or `captureOptionValues` unless I ask.
- Don't wrap SDK calls (`createShardlens`, `lens.*`) in `try`/`catch`: the SDK never throws into the bot.
- Don't change command behaviour, error handling or anything unrelated to these steps.
- The bot must start and behave exactly as before when Shardlens isn't configured, is misconfigured or the collector is down. Never add a check that stops it from starting, and never exit or throw because of Shardlens.
- Do these steps and nothing more. No status commands, owner panels, API routes, dashboards, extra settings (such as a dry-run variable), privacy-notice rewrites or tests of your own invention unless I ask. Suggest them in your summary instead.
- Use the SDK's own methods for what they cover. Don't invent event names or send your own versions of what the SDK records.
- Never print, log, echo or paste a secret or any part of one (keys, tokens, session secrets, settings keys), not even while testing. Say where it is stored instead.

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

Opt-outs are held in memory, so the command's "no longer recorded" reply stops being true at the next restart unless they are saved. If the project has a database, save them there: pass the saved IDs as `optedOut` and save changes in `onOptOutChange` (both options of `createShardlens`; the callback may be `async`, and a failed save is counted, never thrown). If it has none, tell me instead of choosing a store yourself. Also tell me to register the command with Discord if the project registers commands in a separate deploy script.

**My own dashboard.** To show Shardlens numbers in a dashboard or admin panel I already have, install `@shardlens/client` on that panel's server side and ask the collector there. It has no dependencies and uses `fetch`. Never call it from code that runs in a browser: the key would be readable by whoever opens the page. If the panel is a project of its own, without the bot in it, do only this section there: steps 1 to 6 are for the bot.

```ts
import { createShardlensClient, lastDays } from '@shardlens/client';

const shardlens = createShardlensClient({
  endpoint: process.env.SHARDLENS_URL!,
  apiKey: process.env.SHARDLENS_READ_KEY!,
});

const { rows } = await shardlens.commands({ range: lastDays(7) }); // every command: runs, failures, p95, servers
const ticket = await shardlens.command('ticket', { range: lastDays(30) }); // one command in depth
const failing = await shardlens.top({
  metric: 'interactions',
  groupBy: 'command',
  filters: [
    { field: 'guild', value: '112233445566778899' },
    { field: 'outcome', op: 'in', value: ['error', 'timeout', 'no_response'] },
  ],
  range: lastDays(30),
}); // the commands that fail in one server
```

- There is one method per kind of answer (`overview`, `commands`, `command`, `series`, `top`, `heatmap`, `servers`, `server`, `growth`, `audience`, `reliability`, `gauge`, `bursts`, `premium`, `installs`, `events`, `eventProps`, `funnel`, `retention`), `meta()`, and `live()` for the live numbers. Answers are typed; a failed request throws `ShardlensClientError`. Cache answers for a minute: the collector rolls numbers up once a minute.
- It needs two settings where the panel's server runs, `SHARDLENS_URL` (the collector's address, with no path) and `SHARDLENS_READ_KEY` (a read key, `slk_read_…`, not the bot's ingest key). Document them the way step 6 documents the bot's two, and don't make the panel fail to start without them: making the client never throws, and without its settings each call rejects with `invalid_options`, so show "not set up" on those pages instead.
- Follow the panel's existing patterns for routes, data loading and sign-in, and add pages only for what I asked to see.
- Who ran what is separate. Only if I asked for audit mode: `shardlens.activity.log({ guild, command, user, outcome: 'failed', before })` (newest first, 50 rows a page; pass a page's `nextBefore` as `before` for the next) and `shardlens.activity.topUsers('7d')` read it, with `SHARDLENS_ACTIVITY_KEY` (an activity key, `slk_activity_…`) as the client's `apiKey`, on pages only my own staff can open. Never put a user ID in a URL a browser's address bar shows, and add no page that profiles one user beyond that exact-ID lookup.
- Tell me to set the collector up with `npx shardlens init … --dashboard own` (add `--identify-users` for who ran what): it turns the Shardlens dashboard off and writes `dashboard.env` with these settings. Guide: https://kkkermit.github.io/Shardlens/guides/your-own-dashboard/

**Embedded mode**, for a small bot on one host with no separate collector and no MongoDB (a bot on MongoDB uses the MongoDB variant instead): the collector and its dashboard run inside the bot process, with their data in one folder.

- It runs in one process. If the bot uses `ShardingManager` or discord-hybrid-sharding, stop and tell me: those need a standalone collector. Internal sharding is fine.
- Install `@shardlens/collector` and `@electric-sql/pglite` as well as the SDK. In CommonJS, `require('@shardlens/collector/embedded')` works (Node.js 22.12 and later load ES modules with `require`).
- It needs the application ID (from the Developer Portal). Use the setting the project already has for it (often `CLIENT_ID`, `APPLICATION_ID` or a `clientId` in its config); only if it has none, add `DISCORD_APP_ID` next to the bot's other settings.
- The dashboard listens on port 8080 of this machine. Pick another port if the project already uses 8080.
- If I said I want my own dashboard or none, pass `dashboard: false`: the collector then serves its API only, and `collector.readKey` is the key `@shardlens/client` needs (with `endpoint: collector.url`).
- Add the data folder (`shardlens-data` below) to `.gitignore`. Skip step 6: the collector's own address and key replace the two settings.

The collector has to start before `createShardlens`, because the SDK needs its address and key:

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

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await lens.shutdown(); // first, while the collector can still take the last events
    await client.destroy();
    await collector?.close();
    process.exit(0);
  });
}
```

This uses top-level `await`, which needs an ES module. In CommonJS, or where the bot starts inside an `async` function, put these lines in that function (create one around `client.login()` if there is none), before `client.login()`. `lens` then doesn't exist yet when the module registers its listeners, so put it on the client (`client.lens = createShardlens(…)`) and use `client.lens` inside the listeners, creating wrappers on each call as in step 4.

The dashboard is then at `http://127.0.0.1:8080`, and the key to sign in with is `readKey` in `shardlens-data/secrets.json`: tell me where it is, never print it.

**Your own database.** To also keep every event in the database the bot already uses (MongoDB, MySQL, MariaDB, PostgreSQL or SQLite), the collector copies them there; the bot's code doesn't change. With a standalone collector, tell me to set `SHARDLENS_SINK_URL` on the collector. With embedded mode, pass the connection URL the project already reads (never a hard-coded one) as `sink`:

```ts
import { startEmbeddedCollector } from '@shardlens/collector/embedded';

const databaseUrl = process.env.MONGODB_URI; // the setting the bot already uses for its own database
const collector = await startEmbeddedCollector({
  dataDir: './shardlens-data',
  appId: process.env.DISCORD_APP_ID ?? '',
  ...(databaseUrl ? { sink: { to: databaseUrl } } : {}),
}).catch(() => undefined);
```

**Other options** of `createShardlens`: `environment` (default `'production'`), `dryRun` (print events instead of sending them), `disable` (turn off groups: `'interactions'`, `'guilds'`, `'rest'`, `'gateway'`, `'process'`, `'premium'`, `'app'`), `optedOut` and `onOptOutChange` (persist opt-outs), `spool: { dir }` (keep events on disk through long collector outages), `exporters` (Prometheus or OpenTelemetry), `sampleRate` (very large bots), `refreshGuildCounts` (keep member counts current). Every option is documented in the package's type definitions (`node_modules/@shardlens/discordjs/dist/index.d.ts`).

## Check your work

- Run the project's own type-check, lint, build and test scripts, and fix anything you broke.
- With a collector: if `SHARDLENS_URL` and `SHARDLENS_INGEST_KEY` are set in my environment or the bot's `.env`, run `npx shardlens doctor` from the bot's folder and show me its output. It checks Node.js, discord.js, the collector and the key. Never print the key.
- Don't start the bot yourself unless I ask.

## Tell me when you're done

- Which files you changed, and what each change does.
- What I still need to do:
  1. On MongoDB: start the bot and run a command, then run `npx shardlens dashboard` in the bot's folder and open the link it prints (npx fetches the small `shardlens` CLI; it runs the collector the bot installed). It finds the connection string in `.env` or the environment by itself under `MONGODB_URI`, `MONGO_URI`, `MONGODB_URL`, `MONGO_URL`, `MONGODB_CONNECTION_STRING`, `MONGO_CONNECTION_STRING`, `DATABASE_URL`, `DB_URI` or `DB_URL`; for any other name, give me the command with `--env <the bot's name for it>`, never one with the connection string in it. Don't ask me which dashboard I want: on MongoDB it is the Shardlens dashboard, and a dashboard of my own is in the guide: https://kkkermit.github.io/Shardlens/self-hosting/mongodb/
  2. With a standalone collector: run one with `npx shardlens init --domain <my domain> --app-id <my application ID>` (the application ID is the bot's client ID, which the project may already have as `CLIENT_ID` or `APPLICATION_ID`), then `docker compose up -d` in the folder it creates. Ask me which dashboard I want if I haven't said: the Shardlens dashboard (nothing to add), my own (`--dashboard own`) or none (`--dashboard none`); https://kkkermit.github.io/Shardlens/getting-started/choose-your-setup/ compares them. It prints nothing secret; the bot's two settings are in the generated `bot.env`. Guide: https://kkkermit.github.io/Shardlens/getting-started/quick-start/ Then set `SHARDLENS_URL` and `SHARDLENS_INGEST_KEY` where the bot runs.
  3. In embedded mode instead: set the application ID if you added a setting for it, start the bot, and open the dashboard with the read key (say where it is).
  4. To see what would be sent before any of that, pass `dryRun: true` once and run a command in the bot.
- Anything you skipped or weren't sure about.

## If you need more

The whole documentation is available as plain text for agents: an index at https://kkkermit.github.io/Shardlens/llms.txt and everything in one file at https://kkkermit.github.io/Shardlens/llms-full.txt. The collector's HTTP API, as an OpenAPI document: https://kkkermit.github.io/Shardlens/openapi.json. What is collected, field by field: https://kkkermit.github.io/Shardlens/concepts/data-collected/
