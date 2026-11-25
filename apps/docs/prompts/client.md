# Show Shardlens numbers in this project

You are adding `@shardlens/client` to this project: the typed reader of a Shardlens collector, for a dashboard, admin
panel or script of the owner's own. Shardlens is privacy-first analytics for discord.js bots (MIT); the collector
already stores the bot's events. Everything you need is here; you don't need web access. Read before you edit, change
as little as possible and match the project's style.

## Before you start

- The client runs on a **server** only: a backend route, a server component, a script, a cron job. Never in code that
  runs in a browser: its key would be readable by whoever opens the page. If the project is a single-page app with no
  server side, stop and tell me.
- It needs two settings: `SHARDLENS_URL` (the collector's address, with no path) and `SHARDLENS_READ_KEY`
  (`slk_read_…`, not the bot's ingest key). Document both like the project's other settings, as optional strings, and
  never print a key. Without them each call rejects with `invalid_options`: show "not set up" on those pages instead
  of failing.
- On a bot that keeps its data in its own MongoDB, the address is the collector image's, started on the same database
  with `SHARDLENS_READ_KEY` set: https://kkkermit.github.io/Shardlens/self-hosting/mongodb/

## Install and read

Install `@shardlens/client` with the project's package manager. It has no dependencies and uses `fetch`.

```ts
import { createShardlensClient, lastDays } from '@shardlens/client';

const shardlens = createShardlensClient({
  endpoint: process.env.SHARDLENS_URL!,
  apiKey: process.env.SHARDLENS_READ_KEY!,
});

// The ten most used commands of the last week, for a route on the project's own backend.
export async function topCommands() {
  const { rows } = await shardlens.commands({ range: lastDays(7) });
  return rows.slice(0, 10);
}

// One server's numbers, for a per-server page.
export function serverCommands(guildId: string) {
  return shardlens.top({
    metric: 'interactions',
    groupBy: 'command',
    filters: [{ field: 'guild', value: guildId }],
    range: lastDays(30),
    limit: 10,
  });
}
```

Every chart of the Shardlens dashboard has a method: `overview`, `commands`, `command`, `servers`, `server`, `growth`,
`audience`, `reliability`, `premium`, `installs`, `series`, `top`, `heatmap`, `events`, `funnel`, `retention`, and
`live()` for the live tiles.
Their options and answers are in the package's type definitions (`node_modules/@shardlens/client/dist/index.d.ts`).

## Rules

- Counts only. There is no per-user query, and you must not build one. Who ran what is readable only in audit mode,
  with an activity key (`slk_activity_…`), and only if I ask for it; it then belongs behind the project's own sign-in.
- Cache answers briefly on the server (a minute is plenty): the collector's rollups change once a minute.
- Never send a key to the browser, put it in a URL, or log it.

## Tell me when you're done

The files you changed, the two settings to set and where, and what each new page or route shows. Guide:
https://kkkermit.github.io/Shardlens/guides/your-own-dashboard/
