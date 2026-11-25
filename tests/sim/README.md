# Simulated installs

A pre-release test of Shardlens the way bot owners get it: from packed tarballs, installed with npm into bots that
coding agents set up, and run against a fake Discord. It runs on demand and weekly (`.github/workflows/sim.yml`), not
on every pull request.

```sh
pnpm sim               # all eight bots
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

| Bot             | Shape                                                                                  | Collector                       | Copy of the events  |
| --------------- | -------------------------------------------------------------------------------------- | ------------------------------- | ------------------- |
| `js-prefix`     | CommonJS, prefix commands with per-server prefixes and aliases, two slash commands     | Embedded (PGlite)               | SQLite file         |
| `ts-guide`      | TypeScript, discord.js guide layout: subcommands, autocomplete, modals, menus          | Standalone, on PostgreSQL       | MySQL               |
| `ts-sharded`    | TypeScript, discord.js guide layout, two shards through `ShardingManager`              | Standalone, on PostgreSQL       | MySQL               |
| `sapphire`      | Sapphire framework, slash and prefix commands, poll buttons                            | Embedded (PGlite)               | MongoDB             |
| `mongo-prefix`  | CommonJS, mongoose, the same commands as js-prefix                                     | In the bot, on its MongoDB      | (none: it is there) |
| `mongo-sharded` | TypeScript, the native driver, two shards through `ShardingManager`, as ts-sharded     | In each shard, on its MongoDB   | (none)              |
| `mongo-hybrid`  | TypeScript, mongoose, discord-hybrid-sharding (two clusters), the commands of ts-guide | In each cluster, on its MongoDB | (none)              |
| `mongo-modular` | A hand-rolled modular TypeScript codebase, internal sharding, the commands of sapphire | In the bot, on its MongoDB      | (none)              |

The four `mongo-` bots keep their own data in MongoDB, and the install keeps Shardlens's there too (the SDK's
`mongodb` option): no collector process runs. The collector image on the same database reads their numbers, as a
hosted dashboard would, and `shardlens dashboard`, run in the bot's folder with only a `.env`, must sign in with its
one-time link and read the same. Their outage is MongoDB's own (stopped and started again), and the leak check reads
the `shardlens_` collections only: the bots' own collections hold user IDs and typed text by design. The sim's MongoDB
has a password, like Atlas, which must appear in no log or collection.

The bots' code is kept as the agents wrote it (Prettier skips `bots/`), with one fix an owner would make: ts-guide's
error reply no longer throws when the interaction has expired. Don't tidy it; a better install belongs in the docs and
the install prompt. The fake points discord.js at itself through `fake-discord/preload.cjs`, loaded through `NODE_OPTIONS` so
that a `ShardingManager`'s shard processes load it too, which also moves the embedded collectors' hard-coded ports. The
fake runs as many shards as a bot's entry in `bots.mjs` asks for (`SIM_SHARDS`), each server on the shard Discord would
put it on.

Ports: 1 to 14 after `SIM_PORTS` (default 9600: fake Discords on 9601–9604 and 9611–9614, PostgreSQL, MySQL and
MongoDB on 9607–9609) and 1 to 24 after `SIM_COLLECTOR_PORTS` (default 8600: collectors on 8601–8604 and 8611–8614,
`shardlens dashboard` on 8621–8624), all on 127.0.0.1. Container names start with
`SIM_CONTAINERS` (default `shardlens-sim`), so two runs on one machine need different ports and prefixes. Set `TMPDIR`
to choose where the temporary folder goes.
