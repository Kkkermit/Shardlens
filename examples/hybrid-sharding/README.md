# hybrid-sharding

Shardlens with [discord-hybrid-sharding](https://www.npmjs.com/package/discord-hybrid-sharding): several shards per
cluster process. Create one Shardlens instance per cluster, in the cluster file (`src/bot.ts`).

Set `client.cluster` (the `ClusterClient`) before calling `createShardlens`: Shardlens reads the cluster ID and its
shard list from it, so every event is tagged with the right shard and cluster.

```sh
cp .env.example .env      # add DISCORD_TOKEN and SHARDLENS_INGEST_KEY
pnpm start
```

Register a `/ping` command first (for example with `examples/basic-bot`'s `pnpm register`). See the
[sharding guide](https://kkkermit.github.io/Shardlens/guides/sharding/).
