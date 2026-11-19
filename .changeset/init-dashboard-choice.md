---
'shardlens': minor
---

Choose where you look at the numbers when you set up a collector.

- `shardlens init --dashboard shardlens | own | none`. `own` turns the Shardlens dashboard off and writes
  `dashboard.env`, the settings the server of your own dashboard needs to read the numbers with `@shardlens/client`.
  `none` runs the collector as an API only. The default is the Shardlens dashboard, as before, and running `init`
  again changes the choice only when the option is given.
- With `own` or `none`, `--identify-users` also writes `SHARDLENS_MODE=audit` and an activity key, because there is
  no Settings page to switch audit mode on in. The next steps then say to switch the bot to audit mode too.
- `shardlens keys --scope activity` prints an activity key.
