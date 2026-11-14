# 0009. Never read or cancel shared REST response bodies

- Status: Accepted
- Date: 2026-11-13

## Context

Spec sections 5.6 and 13 say to read the `response` event's argument with `response.json()` (to get Discord error
codes such as 10062) and otherwise to `response.body.cancel()` it, because discord.js clones every response when a
`response` listener exists.

Reading @discordjs/rest 2.6.3 shows that is only true for genuine WHATWG `Response` objects
(`res instanceof Response ? res.clone() : { ...res }`). In Node, the default strategy is undici's `request`, which
returns a plain `ResponseLike`. The listener then receives a **shallow copy whose `body` and `json()` share the very
stream discord.js reads next**. Reading it would steal the bot's response (discord.js then fails to parse the error);
cancelling it would break every REST call. Either would violate the first safety rule: the SDK must never hurt the
bot.

## Decision

- The adapter reads or cancels the argument's body **only** when it is a genuine `Response` (global `fetch`, Bun,
  Deno, or a bot that sets `makeRequest: fetch`). Otherwise it never touches the body.
- Without a readable body, a failed interaction callback is classified from its status: 404 on
  `/interactions/:id/:token/callback` is a missed deadline (`timeout`, error code 10062); other statuses are `error`.
  `lens.wrap()` still records exact Discord error codes from the `DiscordAPIError` the bot's handler receives.
- REST latency comes from wrapping the documented `makeRequest` option. The wrapper records the duration in a
  `WeakMap` keyed by the `init.headers` object, which is the same object @discordjs/rest passes as
  `request.options.headers` to the `response` event. Timing is joined to the bucketed route by object identity; no
  header value is ever read.
- `client.rest.options` is typed `readonly`, but @discordjs/rest reads `options.makeRequest` at call time. The adapter
  assigns its wrapper there and restores the original on `shutdown()` if it is still installed.
- Two regression tests cover this: an undici-style single-use response must still reach the bot as a
  `DiscordAPIError` with code 10062, and a genuine `Response` clone may be read for its code (40060) while the bot
  still gets its own copy.

## Consequences

- On Node's default strategy, callback errors other than 404 carry no Discord error code unless the handler is
  wrapped. That is a small loss of detail in exchange for never interfering with the bot.
- Every adapter test also validates what it sent against `@shardlens/schema` (a contract test). That check already
  caught a guild with no `shardId` producing an invalid `guild_join`.
