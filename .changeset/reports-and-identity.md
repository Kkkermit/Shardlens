---
'@shardlens/collector': minor
'@shardlens/discordjs': minor
'@shardlens/http': minor
'@shardlens/schema': minor
'@shardlens/core': patch
'shardlens': minor
---

Scheduled reports: a daily or weekly summary (commands, unique users, failures, response time, servers, top commands)
posted to a Discord channel through its webhook, set up on the new Reports page. Identified users (audit mode) now
record exactly a user ID, a username and an avatar: `auditIncludeProfile` (default `true`) replaces
`auditIncludeNames`, the display name is no longer collected, and the Activity log shows the avatar.
`shardlens init --identify-users` creates the audit key, and `shardlens privacy --ids-only` replaces `--names`.
