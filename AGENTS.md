# Shardlens — rules for coding agents

## Commands

- Install: `pnpm install` (also installs the pre-commit hook, which formats and lints staged files)
- Everything: `pnpm check` (must pass before every commit): format check, lint, types, tests, builds, package lint,
  API reports, unused code (knip), bundle size. Tests run in a step of their own after the rest: on a 4-core CI runner,
  tests sharing the CPU with builds and type-checks run out of time at random
- Format: `pnpm format` (Prettier formats; Biome lints and sorts imports)
- Unit tests: `pnpm test` · one package: `pnpm --filter @shardlens/core test`
- Refresh API reports after a public API change: `pnpm api`
- Integration: `pnpm --filter @shardlens/collector test:int` (needs Docker) · end to end:
  `pnpm --filter @shardlens/dashboard test:e2e` · SDK benchmark: `pnpm --filter @shardlens/discordjs bench`
- Dev: `docker compose -f deploy/docker-compose.dev.yml up -d && pnpm dev`

## Non-negotiables

1. The SDK never throws into, blocks, or crashes the host bot. Wrap every listener with `safe()`; count failures.
2. Never store or log tokens, REST paths, request options/headers, message content, or raw user IDs (raw IDs only in
   audit mode, encrypted).
3. Privacy mode is the default. Do not add any per-user view, profile, or `groupBy: user` capability.
4. Public discord.js APIs only. No monkey-patching of private fields.
5. Validate at trust boundaries (collector ingress, webhook endpoint) with zod; parameterised SQL only.
6. Render all Discord-sourced text as text. No `dangerouslySetInnerHTML`.
7. TypeScript stays on 6.0.x; `erasableSyntaxOnly` (no enums, namespaces, parameter properties).
8. Every change to collected fields, metrics, options or the HTTP API updates the MDX docs and generated tables in the
   same PR (`packages/schema/src/collected-fields.ts` and `metrics.ts` are enforced by tests).
9. Every published-package change needs a Changeset. Conventional Commits.
10. Tests accompany code. Bugs get regression tests.
11. `@shardlens/core` has zero runtime dependencies and uses Web-standard APIs only (no Node built-ins).

## Architecture

The decision records in `docs/adr/` and the docs site (`apps/docs`, concepts and reference sections) describe how
Shardlens works and why. Add an ADR when you change one of those decisions.

## Code style

- Comments explain why, or a constraint the code can't show. Don't restate the code, narrate changes or add section
  banners. Public options and exports keep a short JSDoc: the docs site's reference pages are generated from them.
- No `any`, no `@ts-ignore`. Un-export what only one file uses; delete what nothing uses (`pnpm unused`).
- One page or one concern per file, named for what it holds.

## Layout

- `packages/schema`: wire format (zod), JSON Schema emit, metric registry, data-collected register, Gateway event coverage
- `packages/core`: UUIDv7, user hashing, custom-ID normaliser, secret redaction, histograms, bounded queue, transport helpers
- `packages/discordjs`: discord.js adapter (interactions, REST hooks, guilds, shards, premium, `/privacy` command); `bench/` overhead benchmark
- `packages/cli`: `shardlens` CLI (init, keys, privacy, doctor)
- `packages/http`: `@shardlens/http` for HTTP-interaction bots (Workers, Deno, Bun, `@discordjs/core`); Web APIs only
- `packages/client`: `@shardlens/client`, a typed reader of the collector (queries, live stream, activity log) for other
  dashboards and scripts; zero dependencies, Web APIs only. Its types are written by hand: the collector's
  `test/client-types.test.ts` and `test/client.int.test.ts` fail when a query spec or an answer changes without them
- `packages/exporter-prometheus`, `packages/exporter-otel`: metrics exporters; instruments come from `EXPORTER_METRICS` in core
- `apps/collector`: Fastify + PostgreSQL: ingest, config, query, live (SSE), auth, settings/keys/alerts, audit, privacy erase,
  Discord webhook events, badges; jobs (rollups, uniques, salts, retention, alerts); `dist/cli/seed.js` demo data;
  `./embedded` export (PGlite, ADR 0012); optional ClickHouse analytics store (`storage/clickhouse.ts`); the
  dashboard pages are optional (`SHARDLENS_DASHBOARD=off`) and activity keys read the audit log for other dashboards
  (ADR 0020)
- `apps/dashboard`: React dashboard served by the collector (Playwright + axe e2e in `e2e/`)
- `apps/docs`: Starlight docs site; code samples in `snippets/` are type-checked; data, metrics, options, SDK and HTTP API pages are generated;
  `prompts/install.md` is the prompt people paste into a coding agent (served at `/install.md`, its samples are
  type-checked by `scripts/check-prompt.mjs`); `llms.txt`, `llms-small.txt` and `llms-full.txt` are generated for agents
- `examples/`: `basic-bot` (minimal), `sharded-bot` (ShardingManager and internal), `hybrid-sharding`, `audit-mode`,
  `cloudflare-worker`
- `tests/load`: k6 ingest load test (`.github/workflows/load.yml`)
- `deploy/`: docker-compose (production, dev, ClickHouse override), Caddyfile, `.env.example`, Railway and Render
  templates, Grafana dashboard
- `docs/adr`: architecture decision records
