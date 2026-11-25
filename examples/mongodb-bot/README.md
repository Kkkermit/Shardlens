# mongodb-bot

A discord.js bot that keeps its Shardlens data in its own MongoDB. Nothing else runs: the collector runs inside the
bot, on the database in `MONGODB_URI`, in collections prefixed `shardlens_`. It needs Node.js 22.12 or newer and
MongoDB 7.0 or newer (Atlas's free tier works).

```sh
cp .env.example .env      # add DISCORD_TOKEN and your MONGODB_URI
pnpm register             # registers /ping and /roll
pnpm start                # then run /ping in Discord
pnpm dashboard            # in another terminal: opens the dashboard with a one-time sign-in link
```

[On your MongoDB](https://kkkermit.github.io/Shardlens/self-hosting/mongodb/) has the details.
