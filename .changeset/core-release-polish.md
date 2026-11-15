---
'@shardlens/core': minor
---

Fixes found by soak-testing the client against a collector that flaps, hangs, rate limits with odd `Retry-After`
values, rejects events and sends broken replies, across salt-period boundaries and clock steps:

- No user events are lost when a salt period starts. The SDK asks for the next period's salt 1 to 4 minutes before the
  boundary, while the collector serves it; before, it asked just after, so a busy bot dropped user events at every
  boundary (daily with a `day` salt period) while they waited for the salt.
- After a clock step, or a machine waking from sleep, into a period the SDK has no salt for, it asks for one within
  seconds instead of at the next hourly refresh, dropping user events until then.
- The SDK holds only the salts the collector serves, so a salt destroyed there no longer stays in the bot's memory, and
  an erasure names only live periods. New: `UserHasher.deleteSalt()`.
- During an outage, events go to the spool in full batches rather than one or two at a time, so the spool replays in a
  few requests instead of thousands once the collector is back. While a request hangs, events go to the spool before
  memory fills up; before, they were dropped from memory until the request timed out.
- `stats().dropped` accounts for every event. Rejections in a replayed spool batch, which were counted as replayed, and
  in a `202` reply are counted once each, never the health event; so are events whose builder throws, and user events
  still waiting for a salt at shutdown, whose raw IDs are then released.
- A spooled batch that can't be sent (not a list, or holding `null`) is dropped instead of blocking every later send. A
  spooled batch answered with `413` is split in two and tried again, as batches from memory already were, instead of
  being dropped whole. A dry run never sends events spooled by an earlier run.
- A client that can't send (no `apiKey`, or an endpoint that isn't allowed) queues nothing instead of holding up to
  `maxQueueSize` events.
- `flush()` after `shutdown()` sends nothing, and a request given up at the end of shutdown is not reported as an
  outage. While the collector flaps, "can't reach the collector" is logged at most every 5 minutes.
- `cutText()` and `sanitiseCustomProps()` replace NUL, which the collector refuses, and the source instance goes
  through `cutText()`, so a NUL can't get a whole batch refused. A `source()` that returns something other than an
  object falls back to the default instead of dropping every batch.
- A sample rate below 1/10,000 is used as 1/10,000, the lowest whose weight the collector accepts; lower rates lost
  every event they kept.
- `translateEvent()` skips REST rows and gauges that aren't objects instead of throwing.
- Each batch is serialised once instead of twice. Published files no longer point at source maps the package leaves
  out. An empty `environment` no longer warns.
