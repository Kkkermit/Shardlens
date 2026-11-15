---
'@shardlens/collector': minor
---

Fixes from simulated deployments (Docker Compose behind Caddy, Railway and Render templates, `ShardingManager` and
discord-hybrid-sharding bots):

- `SHARDLENS_TRUST_PROXY` (and `trustProxy` for the embedded collector) accepts the number of proxies in front, such
  as `1`. With `true`, the client address is the left-most `X-Forwarded-For` entry, which a visitor can write when
  the proxy appends to the header, and the sign-in rate limit could be dodged. The Compose file and the Render
  template now use `1`.
- Servers a sharded bot reports before its last shard's first snapshot are existing installs, not joins: they no
  longer show up in size at install, activation, cohorts and lifetimes.
- A restarted shard or cluster process is counted once in gauges (memory, cache sizes, server counts), not added to
  the process it replaced for a minute (or, on the Reliability page, for two).
- The dashboard page is revalidated after an upgrade instead of being served from cache with the old script names;
  hashed assets stay cached for a year.
- The `commands` query returns the kinds each command ran as (`chat_input`, `message_command`, menus), and `command`
  its runs per kind. The dashboard writes `/` only in front of slash commands and marks prefix commands and menus.
- The image build installs dependencies once.
