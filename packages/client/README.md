# @shardlens/client

A typed client for reading a [Shardlens](https://github.com/Kkkermit/Shardlens) collector from your own dashboard or
scripts: every query the built-in dashboard runs, the live numbers and, in audit mode, the activity log.

- Every answer is typed, so your editor knows what a query returns.
- Zero dependencies and Web-standard APIs only (`fetch`, `URL`, `AbortSignal`, streams): it runs on Node.js 20+, Bun,
  Deno, Cloudflare Workers and in Next.js route handlers.
- Runs on your server. A key in a browser can be read by every visitor, so call the client from your backend and send
  the browser only what a page needs.

```sh
npm install @shardlens/client
```

```ts
import { createShardlensClient, lastDays } from '@shardlens/client';

const shardlens = createShardlensClient({
  endpoint: process.env.SHARDLENS_URL!, // https://stats.example.com
  apiKey: process.env.SHARDLENS_READ_KEY!, // slk_read_…
});

// A route on your own backend: a Next.js route handler, Hono, a Worker, Bun.
export async function GET(): Promise<Response> {
  const { rows } = await shardlens.commands({ range: lastDays(7) });
  return Response.json(rows.slice(0, 10), { headers: { 'cache-control': 'private, max-age=60' } });
}
```

The two settings come from your collector. `npx shardlens init … --dashboard own` sets one up without the Shardlens
dashboard and writes both to `dashboard.env`; with a collector that is already running, the read key is
`SHARDLENS_READ_KEY` in its `.env`, or a new one from **Settings → API keys**.
[Choose your setup](https://kkkermit.github.io/Shardlens/getting-started/choose-your-setup/) compares the options.

## What you can read

| Method                                           | What it answers                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------------- |
| `overview()`                                     | The bot at a glance: 30 days of runs, servers, users, events arriving     |
| `commands({ range })`                            | Every command: runs, change, error rate, p95, servers, unique users       |
| `command(name, { range })`                       | One command: outcomes, subcommands, options, servers, components, modals  |
| `series({ metric, interval, range })`            | A metric over time, optionally split with `groupBy`                       |
| `top({ metric, groupBy, range })`                | The busiest values of a dimension: commands, servers, routes              |
| `heatmap({ range })`                             | Counts by weekday and hour                                                |
| `servers({ … })`, `server(guildId)`              | The server list, filtered and sorted; one server's profile and history    |
| `growth({ range })`, `installs({ range })`       | Joins and leaves, activation, cohorts; user installs                      |
| `audience({ range })`                            | Unique users per day, week and period; locale, install and context splits |
| `reliability({ range })`                         | Missed deadlines, errors, REST, rate limits, shards, SDK health           |
| `gauge({ name, interval, range })`               | Shard ping, memory, event-loop delay over time                            |
| `bursts({ range })`                              | Minutes with far more runs than usual                                     |
| `premium({ range })`                             | Entitlements and subscriptions by SKU                                     |
| `events({ range })`, `eventProps({ … })`         | Custom events and their properties                                        |
| `funnel({ steps, range })`, `retention({ … })`   | Conversion through steps; who comes back                                  |
| `query(spec)`                                    | Any of the above as one spec; the answer's type follows `spec.kind`       |
| `meta()`                                         | The app's name, mode, salt period, time zone and retention                |
| `live({ signal })`                               | What the bot is doing right now, about once a second                      |
| `activity.log({ … })`, `activity.topUsers('7d')` | Who ran what (audit mode, with an activity key)                           |

Filters narrow a query. One server's most used commands, and the ones that fail there:

```ts
const top = await shardlens.top({
  metric: 'interactions',
  groupBy: 'command',
  range: lastDays(30),
  filters: [
    { field: 'guild', value: guildId },
    { field: 'outcome', op: 'in', value: ['error', 'timeout', 'no_response'] },
  ],
});
```

Every method takes `{ signal }` as its last argument to cancel the request.

## Live numbers

`live()` reads the collector's Server-Sent Events stream as an async iterable. The connection opens when the loop
starts and closes when it ends: when the signal aborts, when you `break`, or when the collector closes the stream (a
restart, a proxy's time limit). If the connection breaks instead, the loop throws a `ShardlensClientError`: `network`,
or `timeout` when the collector has sent nothing for 45 seconds. It sends a heartbeat every 15 seconds, so that only
happens to a connection that died without either end closing it.
Call `live()` again to reconnect.

The collector keeps up to 10 live streams open per address (100 in all) and refuses more with `busy` and
`retryAfterSeconds`, so a backend that passes the numbers on to its visitors should share one stream between them.

```ts
for await (const update of shardlens.live({ signal })) {
  console.log(update.perMinute, 'commands in the last minute', update.servers, 'servers');
}
```

## Who ran what

A collector in [audit mode](https://kkkermit.github.io/Shardlens/guides/audit-mode/) (switched on in the collector
and in the bot) keeps an activity log. Reading it takes an activity key (`slk_activity_…`), which can also do
everything a read key can. The collector records every read in its access log.
`npx shardlens init … --dashboard own --identify-users` creates one, as does **Settings → API keys**. Use it only on
pages your own staff can open.

```ts
const shardlens = createShardlensClient({
  endpoint: process.env.SHARDLENS_URL!,
  apiKey: process.env.SHARDLENS_ACTIVITY_KEY!, // slk_activity_…
});

// Who ran into a failure in this server? Page back with `nextBefore`.
const guildId = '112233445566778899';
let before: string | null = null;
do {
  const page = await shardlens.activity.log({ guild: guildId, outcome: 'failed', before });
  for (const row of page.rows) console.log(row.ts, row.userId, row.command, row.outcome);
  before = page.nextBefore;
} while (before);
```

## Errors

Everything that goes wrong is a `ShardlensClientError`. Its message never contains the key. Making a client never
throws, so it can be made when a module loads even where the settings are missing (a build, a test run): each call then
rejects with `invalid_options` and says which setting is wrong.

```ts
import { ShardlensClientError } from '@shardlens/client';

try {
  await shardlens.activity.log();
} catch (error) {
  if (!(error instanceof ShardlensClientError)) throw error;
  error.status; // 403; 0 when the collector gave no answer
  error.code; // 'activity_key_required'
}
```

| `status` | `code`                             | Meaning                                                                                   |
| -------- | ---------------------------------- | ----------------------------------------------------------------------------------------- |
| 400      | `invalid_request`, `invalid_query` | The collector refused the query; the message says which part                              |
| 401      | `unauthorized`                     | The key is wrong or revoked                                                               |
| 403      | `activity_key_required`            | The activity log was asked for with a read key                                            |
| 404      | `audit_mode_off`                   | The collector is not in audit mode                                                        |
| 429      | `rate_limited`                     | Too many requests: wait `retryAfterSeconds`                                               |
| 500      | `internal`                         | The collector failed: `requestId` finds the request in its log                            |
| 503      | `busy`                             | `live()` found every stream taken: wait `retryAfterSeconds`                               |
| 3xx      | `http_<status>`                    | `endpoint` redirects elsewhere, which the client doesn't follow                           |
| 2xx      | `invalid_response`                 | The answer isn't a collector's: check `endpoint`                                          |
| 0        | `timeout`, `network`               | No answer within `timeoutMs` (default 10 s), or none at all; a live stream quiet for 45 s |
| 0        | `invalid_options`                  | An `endpoint` or `apiKey` the client can't use: every call says which                     |

A request cancelled with your own `signal` rejects with that signal's reason, as `fetch` does.

## Links

- [Your own dashboard guide](https://kkkermit.github.io/Shardlens/guides/your-own-dashboard/) ·
  [documentation](https://kkkermit.github.io/Shardlens/) ·
  [what is collected](https://kkkermit.github.io/Shardlens/concepts/data-collected/)
- Using an AI coding agent? Point it at [`client.md`](https://kkkermit.github.io/Shardlens/prompts/client.md), a self-contained prompt for adding this package,
  or [`llms.txt`](https://kkkermit.github.io/Shardlens/llms.txt), the docs as plain text.
- [Source and issues](https://github.com/Kkkermit/Shardlens) · MIT licence · not affiliated with Discord
