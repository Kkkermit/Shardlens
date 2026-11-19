# Simulated installs

A pre-release test of Shardlens the way bot owners get it: from packed tarballs, installed with npm into bots that
coding agents set up, and run against a fake Discord. It runs on demand and weekly (`.github/workflows/sim.yml`), not
on every pull request.

```sh
pnpm sim               # all four bots
pnpm sim ts-guide      # one or more of them
```

It needs Docker and takes about five minutes. It:

1. builds and packs every published package (`pnpm pack`) into a temporary folder;
2. copies the bots in `bots/` there and installs them with npm, with every `@shardlens/*` package (and the CLI)
   pointing at the tarballs;
3. starts the databases the bots use in Docker: `shardlens-sim-postgres` for the standalone collector,
   `shardlens-sim-mysql` for its copy of the events and `shardlens-sim-mongo` for the Sapphire bot;
4. runs each bot against the fake Discord (`fake-discord/`), which sends it a scripted scenario
   (`fake-discord/scenarios.mjs`), then checks the collector's counts against what was sent, stops the bot with
   `SIGINT` (a sharded bot's manager has to pass it on to its shards) and searches the logs, the collector's database and the copy for raw user IDs, usernames, display names,
   avatars, the bot token, interaction tokens and typed text;
5. reads the same numbers the way an owner's own dashboard would: `panel/` is a project with `@shardlens/client`
   installed from its tarball, loaded as an ES module and as CommonJS, and its runs per command must match the
   collector's API;
6. prints a summary and exits non-zero on a count that differs, a leak, an empty copy, an unclean shutdown or a REST
   route the fake doesn't know. Containers and processes are always removed; logs are kept when the run fails.

| Bot          | Shape                                                                              | Collector                 | Copy of the events |
| ------------ | ---------------------------------------------------------------------------------- | ------------------------- | ------------------ |
| `js-prefix`  | CommonJS, prefix commands with per-server prefixes and aliases, two slash commands | Embedded (PGlite)         | SQLite file        |
| `ts-guide`   | TypeScript, discord.js guide layout: subcommands, autocomplete, modals, menus      | Standalone, on PostgreSQL | MySQL              |
| `ts-sharded` | TypeScript, discord.js guide layout, two shards through `ShardingManager`          | Standalone, on PostgreSQL | MySQL              |
| `sapphire`   | Sapphire framework, slash and prefix commands, poll buttons                        | Embedded (PGlite)         | MongoDB            |

The bots' code is kept as the agents wrote it (Prettier skips `bots/`), with one fix an owner would make: ts-guide's
error reply no longer throws when the interaction has expired. Don't tidy it; a better install belongs in the docs and
the install prompt. The fake points discord.js at itself through `fake-discord/preload.cjs`, loaded through `NODE_OPTIONS` so
that a `ShardingManager`'s shard processes load it too, which also moves the embedded collectors' hard-coded ports. The
fake runs as many shards as a bot's entry in `bots.mjs` asks for (`SIM_SHARDS`), each server on the shard Discord would
put it on.

Ports: the nine after `SIM_PORTS` (default 9600: fake Discords, then PostgreSQL, MySQL and MongoDB on 9607–9609) and
after `SIM_COLLECTOR_PORTS` (default 8600: the collectors), all on 127.0.0.1. Container names start with
`SIM_CONTAINERS` (default `shardlens-sim`), so two runs on one machine need different ports and prefixes. Set `TMPDIR`
to choose where the temporary folder goes.
