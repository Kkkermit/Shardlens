---
'@shardlens/discordjs': minor
---

Runs on every discord.js release it claims, and keeps events whole when values are out of range:

- The ES module build no longer fails to load on discord.js 14 releases that don't export `ApplicationIntegrationType`
  or `InteractionContextType` (14.14 and 14.15, among others), and buttons, select menus, modals and autocomplete are
  recorded on 14.18 and older, which have no `isPrimaryEntryPointCommand()`. The peer range now starts at
  discord.js 14.12: earlier releases use `@discordjs/rest` 1, whose responses the SDK can't read. Application info is
  sent on releases without `fetchSKUs()` (before 14.15).
- A global rate-limit wait is recorded with scope `global` (discord.js reports every wait as `user`), and a component
  whose handler fails after its row was sent is attributed to the command that created its message.
- Numbers the wire format refuses no longer drop the whole event: non-finite rate-limit and invalid-request values,
  negative boosts, out-of-range handler times and error codes that aren't safe integers are clamped or left out, and a
  custom event's server ID must be a valid snowflake (a 20-digit one is left out instead of losing the event).
- An `async` `onOptOutChange` (or one returning any thenable) that rejects is counted, not left as an unhandled
  rejection that could stop the bot.
- `CustomEvents` is exported, so typed custom events can be declared on `@shardlens/discordjs`, which also works with
  pnpm, where `@shardlens/core` isn't resolvable from the bot's code.
- `saltPeriod` is documented as having no effect (the collector decides) and marked deprecated. The published files no
  longer point at source maps they don't include.
