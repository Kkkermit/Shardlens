---
'@shardlens/discordjs': minor
---

`lens.handlerStarted(interaction)` and `lens.handlerFinished(interaction, { durationMs, error })` record handler time
and failures for frameworks that run handlers themselves and announce it, such as Sapphire's
`chatInputCommandRun`/`chatInputCommandSuccess`/`chatInputCommandError` events. `wrap()` and these methods now accept
any `BaseInteraction`, including the `ContextMenuCommandInteraction` frameworks pass.
