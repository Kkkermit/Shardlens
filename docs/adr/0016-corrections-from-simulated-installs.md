# 0016. Corrections from simulated installs

- Status: Accepted
- Date: 2026-11-14

## Context

Before the first release, four independent runs installed Shardlens from its packed tarballs the way a bot owner
would (single process, `ShardingManager`, HTTP interactions, embedded mode), drove simulated servers and commands
through it, and compared what the dashboard and the query API reported with what had been sent. Every event was
accounted for and no raw user ID reached a database, but the runs showed places where a number meant something other
than its label, and a few decisions that did not hold up in use.

## Decision

- **The server owner's ID is not collected.** Audit mode used to send and store it, encrypted
  ([0002](0002-audit-mode.md), [0011](0011-m2-privacy-admin-decisions.md)). [0015](0015-reports-and-identified-users.md)
  says an identified user is exactly an ID, a username and an avatar on their own interactions; an owner who never
  ran a command is not that. `ownerId` is gone from the wire format and `guilds.owner_enc` is dropped (migration 005).
- **A missed deadline is any interaction the user saw fail for time.** That is a reply Discord refused as too late
  (`timeout`) and an interaction that got no reply at all (`no_response`). The reliability page, the report and the
  `missed_deadline_rate` alert count both; `noResponse` is still reported on its own. In the SDK, Discord's verdict on
  the first response wins over an error the handler throws afterwards.
- **A rollup range starts at the bucket it falls in.** Rollups are stored under the start of their hour (or day, past
  13 months), so a range starting at 15:20 used to skip everything before 16:00. Reading now starts at 15:00. The
  range can therefore include up to one bucket more than was asked for, and never less. ClickHouse, which keeps
  minutes, is given the range as asked.
- **A query can only use dimensions its metric keeps.** Anything else is refused with `invalid_query` and a message
  listing them. It used to return one row with an empty key, or nothing, which read as "no data".
- **Gauges are combined per kind.** Every shard and process reports its own samples. Totals (servers per shard,
  memory, cache sizes) are added up across sources minute by minute; latencies are averaged, with the worst kept as
  the maximum. Averaging everything made a four-shard bot look like one shard.
- **Unique users are per UTC day, and the day a range ends in is part of it.** A report in another time zone uses the
  UTC day whose midday falls inside its local day.
- **SDK health is kept 30 days.** A process is identified by host name and process ID, so every restart is a new row.
  The data register now says that the instance label and SDK version are stored, which it did not.

## Consequences

- Dashboards built on the query API see larger "missed deadline" figures than before for bots with handlers that
  never reply, and get a `400` where they used to get an empty answer for an unsupported `groupBy` or filter.
- "Last hour" and "last 24 hours" include the part of the first hour before the range began. This is documented with
  the query API.
- A collector that upgrades loses the encrypted owner IDs it stored. Nothing read them.
- Percentiles are still the upper edge of a histogram bucket, up to a third above the true value. Interpolating
  inside the bucket was considered and left for later: it changes every latency figure at once and deserves its own
  comparison against exact values.
