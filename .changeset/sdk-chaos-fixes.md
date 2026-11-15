---
'@shardlens/core': patch
'@shardlens/discordjs': patch
'@shardlens/http': patch
---

Fixes from chaos-testing the SDKs against a hostile collector, bad options and real discord.js clients:

- Options of the wrong type (a number `environment` or `release`, an exporter passed without the array, an `optedOut`
  or `disable` that isn't a list, no options at all) are ignored or converted with one warning, never thrown. With
  `@shardlens/http`, one bad option made every wrapped handler fail.
- Erasing a user drops their events still waiting to be sent (in memory, waiting for a retry, or in the disk spool),
  so they can't arrive after the erasure and survive it.
- REST routes hold route words only: invite and template codes, tokens, query strings and any other value become
  placeholders, so they never leave the bot or become metric labels.
- `captureOptionValues` never records user, channel, role, mentionable or attachment options, nor any value holding a
  Discord ID. Values and names are cut on whole characters, so PostgreSQL never refuses a batch for half an emoji.
- A bot's own REST `response` listener can read the response body again with Shardlens attached (fetch-based REST,
  Bun, Deno).
- The disk spool works when shards share a folder: the size cap covers the folder, a segment is never handed out again
  after it was accepted (even on a read-only volume), and leftover temp files are cleaned up. Events go to the spool
  during an outage that started before the collector was first reached.
- No salt yet for the current period (a clock slightly ahead of the collector's) is asked for again within seconds, not
  an hour later, and a clock more than 30 seconds off is warned about once. The SDK keeps three salts, so the next
  period's, which the collector now sends just before a boundary, is ready when it starts.
- Replies from the collector are read up to a size limit; secret redaction takes linear time on long input.
- Retries never come sooner than the backoff, whatever `Retry-After` says; a failed batch goes back in one step.
- `shutdown()` accepts `null` and non-numeric timeouts, and aborts requests still hanging when it ends, so the process
  can exit.
- `refreshGuildCounts` doesn't pile up requests while Discord is slow, and two Shardlens instances on one client
  restore the REST client whatever order they shut down in.
- Dry-run output hides audit identities, error listeners get errors with tokens and request bodies removed, and opted-out
  IDs may be BigInts.
