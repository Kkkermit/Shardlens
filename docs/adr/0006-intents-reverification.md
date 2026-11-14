# 0006. Gateway intents re-verified against Discord's docs

- Status: Accepted
- Date: 2026-11-13

## Context

Spec section 5.2 maps every Gateway dispatch event to an intent and a use. M0 requires re-checking it against
<https://docs.discord.com/developers/events/gateway.md> before building on it.

## Findings (13 Nov 2026)

- **Matches:** `GUILDS` (1 << 0) delivers guild, role, channel, thread and stage-instance events. Privileged intents are
  `GUILD_MEMBERS`, `GUILD_PRESENCES` and `MESSAGE_CONTENT`. Any event not listed under an intent is always sent, which
  covers `INTERACTION_CREATE`, `READY`, `RESUMED`, entitlements, subscriptions and
  `APPLICATION_COMMAND_PERMISSIONS_UPDATE`. 2,500 servers per shard; 1,000 identifies per 24 hours across shards,
  exceeding it resets the bot token.
- **Difference:** `VOICE_CHANNEL_STATUS_UPDATE` and `VOICE_CHANNEL_START_TIME_UPDATE` are now documented under
  `GUILDS`. The spec listed them as present in types with little or no public documentation.
- `CHANNEL_INFO` remains undocumented. Reactions, typing and polls have separate guild and DM intents.

## Decision

- No change to what Shardlens collects: the two voice-channel events are delivered with `GUILDS` but not used.
- The table is now code (`@shardlens/schema` `GATEWAY_EVENT_COVERAGE`). A unit test compares it with
  `GatewayDispatchEvents` from discord-api-types 0.38.59 (79 events), and fails when an event is added or removed, and
  when any event outside `GUILDS` or no-intent is marked as used.

## Consequences

- Each discord-api-types update that adds an event forces an explicit decision (map it, or mark it ignored) plus an
  ADR if the treatment is non-obvious.
