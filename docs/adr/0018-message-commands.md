# 0018. Record message (prefix) commands the bot reports

- Status: Accepted
- Date: 2026-11-15

## Context

Many bots run every command both as a slash command and as a prefix command (`t?ban @someone`). Shardlens only saw
interactions, so for those bots half the usage was missing from the Commands page. A prefix command is an ordinary
`MESSAGE_CREATE`: telling one from chat needs the message's content, the privileged Message Content intent and the
bot's own prefix and command list. Non-negotiable 2 says message content is never stored or logged.

## Decision

- **The bot reports, the SDK never parses.** `lens.trackMessageCommand(message, run)` and
  `lens.wrapMessageCommand(command, handler)` are called after the bot's own parser matched a command. The SDK reads
  the message's author ID (hashed), server, channel type, the server's preferred locale and the author's permissions
  (member tier), and never `content`, attachments or mentions. The command name comes from the bot (after aliases),
  so free text after a prefix never reaches the wire. The adapter still has no `messageCreate` listener and still needs
  only `Guilds`.
- **A new event type, not a new interaction kind.** `message_command` carries only what a message has: no locale,
  install type, entitlements, response type, deferral or acknowledgement time, and an outcome of `ok` or `error` only.
  Reusing `interaction` would have meant inventing values for required fields (`locale`, `premium`) and an outcome
  (`timeout`) that can't happen. Adding an event type is additive within wire v1 ([0004](0004-schema-versioning.md));
  older collectors drop it per event.
- **Stored with interactions as kind 9.** The collector writes message commands into the `interactions` table with
  `locale = ''`, `premium = false` and the interaction-only columns `NULL`, so every command view (Commands, command
  detail, servers, unique users per command, funnels and cohorts, ClickHouse) counts them with a widened kind filter
  (`COMMAND_KINDS_SQL`). A separate table would have meant a second copy of each of those queries.
- **Interaction-only figures exclude kind 9.** The Reliability page (totals and error codes), the
  `missed_deadline_rate` alert, defer and ephemeral rates, and premium share describe Discord interactions and leave
  message commands out, so a busy prefix bot can't dilute its missed-deadline rate. The `error_rate` alert and
  per-command failure rates include them. Language and install-type breakdowns skip their empty values.
- **Audit mode and opt-outs apply.** In audit mode the event carries the same `actor` as an interaction, encrypted
  into `audit_log` with kind 9; `privacyViolation()` rejects an actor on a privacy-mode batch. Opt-outs and
  `disable: ['interactions']` cover message commands.
- **`wrap()` ignores non-interactions.** A wrapped function that also receives a prefix command (for example a
  prefix input shaped like an interaction) runs untouched and records nothing, instead of counting an internal error
  for each call. Interactions are recognised by shape (`id` and `isRepliable()`), not `instanceof`, so a second copy of
  discord.js in `node_modules` still works.

## Consequences

- Bots with prefix commands need one call in their dispatcher. Nothing is recorded for them automatically, by design.
- A component clicked on a message a prefix command sent has no `sourceCommand`: the link is made through
  `interactionMetadata`, which messages sent in reply to a prefix command don't have.
- The Reliability page counts fewer runs than the Commands page for bots with prefix commands. The docs say why.
