# sharded-bot

Shardlens with discord.js sharding. Create one Shardlens instance per `Client`, in the process where that client runs.

- `src/manager.ts` + `src/bot.ts`: `ShardingManager`, one process per shard. Shardlens goes in the shard file.
- `src/internal.ts`: internal sharding, one process for every shard.

```sh
cp .env.example .env      # add DISCORD_TOKEN and SHARDLENS_INGEST_KEY
pnpm start                # ShardingManager
pnpm start:internal       # or internal sharding
```

Register a `/ping` command first (for example with `examples/basic-bot`'s `pnpm register`). Every shard uses the same
ingest key; the dashboard's shard grid shows each one. See the
[sharding guide](https://kkkermit.github.io/Shardlens/guides/sharding/).
