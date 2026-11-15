---
'@shardlens/http': patch
---

Fixes found by running an HTTP-interactions bot on Node, Bun, Deno and Cloudflare's own runtime (workerd) against a
real collector:

- Cloudflare Workers: recording no longer stops for the rest of a Worker instance's life. A Worker ends whatever a
  request started when the request ends, timers and unanswered requests included, so a collector that took more than a
  couple of seconds to answer the first settings request (one waking from sleep), a new salt period, or a flush started
  by a timer could leave Shardlens unable to send anything again. Under `waitUntil`, each request now sends its own
  events with no timer involved, and a client left stuck by an ended request is replaced by the next one. While the
  collector stays unreachable, it is asked again at most every 1 to 60 seconds.
- A command answered with a modal records the modal's custom ID, as the discord.js adapter does, so the dashboard's
  modal funnel works for HTTP bots.
- A PING (Discord checking the endpoint URL) starts nothing: no client, no request to the collector.
- An argument whose `waitUntil` getter throws no longer makes the wrapped handler throw.
- Server and command IDs follow the wire format's rule, and response type, channel type and component type must be
  whole numbers, so one odd value no longer gets the whole event refused. An interaction without a user is not sent.
- Only a JSON `Response` is copied to read the response type; a file or stream is left alone.
- Exporters keep running when a client is replaced, and are shut down by `lens.shutdown()`.
- `track()` accepts a BigInt user ID, and ignores a `waitUntil` argument that has no `waitUntil` method.
- `CustomEvents` is exported, so typed custom events can be declared on `@shardlens/http`, which also works with pnpm,
  where `@shardlens/core` isn't resolvable from the bot's code.
- The published files no longer point at source maps that are not shipped.
