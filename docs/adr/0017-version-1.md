# 0017. Version 1.0 and what it promises

- Status: Accepted
- Date: 2026-11-14

## Context

The packages were held at 0.0.0, with the first release planned as 0.1.0, so that minor versions could still break
things while the project settled. The maintainer chose to release 1.0.0 instead. From 1.0 on, semantic versioning only
means something if it is clear which parts of Shardlens a version number covers.

## Decision

All eight published packages release together as 1.0.0. Within a major version, these do not break:

- **Package APIs**: everything exported by `@shardlens/core`, `schema`, `discordjs`, `http` and the two exporters, as
  recorded in each package's API report (`etc/*.api.md`), including `createShardlens` options.
- **The CLI**: `shardlens` commands and flags, and what `init` writes.
- **The collector**: the HTTP API in `openapi.json`, its environment variables, the `./embedded` export, and data in
  an existing database (migrations stay forward-only and run on start).
- **The wire format** keeps its own major version ([0004](0004-schema-versioning.md)): a collector accepts the current
  and the previous one, so bots and collectors can be upgraded on different days.

Not covered: the dashboard's pages and layout, log message wording, the database schema itself (it is reached through
the collector, not directly), and anything not exported.

A breaking change to anything covered needs a major changeset and a migration note in the changelog.

## Consequences

- API Extractor's reports become the record of what may not break: a change to an `etc/*.api.md` file in a pull
  request is a prompt to check the changeset's bump.
- Fixes found after release that need a breaking change wait for 2.0 or ship behind an option.
- The compose file's default image tag `:1` exists from this release on.
