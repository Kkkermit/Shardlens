# shardlens

The [Shardlens](https://github.com/Kkkermit/Shardlens) command-line tool: set up a self-hosted collector, create keys,
write a paragraph for your privacy policy and check your setup. Shardlens is self-hosted, privacy-first analytics and
health monitoring for discord.js bots.

Needs Node.js 22.12 or newer; no dependencies.

```sh
# Write docker-compose.yml, a Caddyfile, a .env with generated secrets and keys, and bot.env with your bot's two settings
npx shardlens init --domain stats.example.com --app-id 123456789012345678

# The same, for a dashboard of your own (also writes dashboard.env for it) or for none
npx shardlens init --domain stats.example.com --app-id 123456789012345678 --dashboard own

# Print a new API key (ingest, read or activity)
npx shardlens keys --scope read

# Print a privacy-policy paragraph that matches your setup
npx shardlens privacy

# Check Node.js, discord.js, the collector and your key
npx shardlens doctor --url https://stats.example.com --key slk_ingest_…
```

`init` never overwrites files without `--force`, and with it keeps the secrets of an existing `.env`, so it is safe to run
again on a running collector. `doctor` also reads `SHARDLENS_URL` and `SHARDLENS_INGEST_KEY` from the environment or from
a `.env` in the current folder. It only talks to the collector URL you give it, never over plain HTTP except to
localhost, and never prints the key. `shardlens --help` lists every option.

## Links

- [CLI reference](https://kkkermit.github.io/Shardlens/reference/cli/) ·
  [quick start](https://kkkermit.github.io/Shardlens/getting-started/quick-start/) ·
  [documentation](https://kkkermit.github.io/Shardlens/)
- Using an AI coding agent? Point it at [`install.md`](https://kkkermit.github.io/Shardlens/install.md), a
  self-contained install prompt, or [`llms.txt`](https://kkkermit.github.io/Shardlens/llms.txt), the docs as plain text.
- [Source and issues](https://github.com/Kkkermit/Shardlens) · MIT licence · not affiliated with Discord
