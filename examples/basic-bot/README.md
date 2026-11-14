# basic-bot

A minimal discord.js bot that reports to Shardlens. It needs only the `Guilds` intent.

```sh
cp .env.example .env      # add DISCORD_TOKEN and SHARDLENS_INGEST_KEY
pnpm register             # registers /ping and /roll
pnpm start
```

Run a collector first (see the repository README). Set `SHARDLENS_URL` to it.
