# shardlens

The [Shardlens](https://github.com/Kkkermit/Shardlens) command-line tool: set up a self-hosted collector, create keys,
write a paragraph for your privacy policy and check your setup. Shardlens is self-hosted, privacy-first analytics and
health monitoring for discord.js bots.

```sh
# Write docker-compose.yml, a Caddyfile and a .env with generated secrets and keys
npx shardlens init --domain stats.example.com --app-id 123456789012345678

# Print a new API key (ingest or read)
npx shardlens keys --scope ingest

# Print a privacy-policy paragraph that matches your setup
npx shardlens privacy

# Check Node.js, discord.js, the collector and your key
npx shardlens doctor --url https://stats.example.com
```

`doctor` also reads `SHARDLENS_URL` and `SHARDLENS_INGEST_KEY` from the environment. It only talks to the collector
URL you give it and never prints the key.

## Links

- [CLI reference](https://kkkermit.github.io/Shardlens/reference/cli/) ·
  [quick start](https://kkkermit.github.io/Shardlens/getting-started/quick-start/) ·
  [documentation](https://kkkermit.github.io/Shardlens/)
- Using an AI coding agent? Point it at [`install.md`](https://kkkermit.github.io/Shardlens/install.md), a
  self-contained install prompt, or [`llms.txt`](https://kkkermit.github.io/Shardlens/llms.txt), the docs as plain text.
- [Source and issues](https://github.com/Kkkermit/Shardlens) · MIT licence · not affiliated with Discord
