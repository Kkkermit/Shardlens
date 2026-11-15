---
'@shardlens/schema': minor
'@shardlens/core': minor
'@shardlens/discordjs': minor
'@shardlens/collector': minor
---

Record prefix (message) commands. `lens.wrapMessageCommand(name, handler)` and `lens.trackMessageCommand(message, run)`
record a command your bot's parser matched in a message, such as `!ban @someone`, with its outcome, handler time and
error class. The SDK reads the message's author, server, channel type and the author's permissions, and never its
content. Prefix commands are stored with interactions as the `message_command` kind ("Prefix command" on the
dashboard), so the Commands page, unique users, servers, funnels and the exporters count them. Deadline, response-time,
Reliability and premium figures still cover interactions only.

The wire format gains the additive `message_command` event; collectors older than this release drop it per event.
`lens.wrap()` now runs a handler untouched when its first argument isn't an interaction, so one function can serve both
slash and prefix commands.
