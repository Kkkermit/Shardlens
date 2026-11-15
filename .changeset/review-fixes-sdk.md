---
'@shardlens/schema': patch
'@shardlens/core': patch
'@shardlens/discordjs': patch
'@shardlens/http': patch
'shardlens': patch
---

Fixes from a full review of the SDK packages:

- `shutdown()` sends events whose user hash was still being computed, instead of dropping them.
- Numeric options that aren't numbers (`Number(process.env.UNSET)`) fall back to their defaults instead of throwing
  into the bot, stopping sends or running a 1 ms timer.
- A rejected API key is reported as a rejected key even when its reply can't be read, and the "connected" log line
  follows a spool replay after an outage.
- Opt-outs work with `disable: ['interactions']`, and an opted-out user's entitlements and subscriptions are dropped
  too, as the privacy docs say.
- A REST window stays within the wire format's 2,000-row limit, so the collector no longer rejects it whole.
- Bot processes sharing a spool folder can't replace each other's segments, and `spool.maxBytes` that isn't a number
  keeps the default cap.
- `@shardlens/http`: unsubscribing an error listener added before the first event works.
- `shardlens privacy --retention abc` fails instead of printing the default, and `doctor` no longer contradicts its own
  key check.
