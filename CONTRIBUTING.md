# Contributing to Shardlens

Thanks for helping. Shardlens is MIT-licensed and built in the open.

## Setup

- Node 24.11+ (`.nvmrc`), pnpm 12 (`corepack enable`), and Docker for the collector and its integration tests.

```sh
pnpm install
pnpm check
```

`pnpm install` also sets up a pre-commit hook (Husky and lint-staged) that formats and lints the files you staged.

`pnpm check` runs the Prettier format check, Biome lint, typecheck, unit tests, builds, package lint (publint and
attw), API Extractor reports, unused-code detection (knip) and the size budget. It must pass before every commit.
`pnpm format` fixes formatting and import order.

## Rules

The non-negotiables are in [AGENTS.md](AGENTS.md) and apply to humans too. The short version:

- The SDK never throws into, blocks, or crashes the host bot.
- Never store or log tokens, raw REST paths, request headers, message content, or raw user IDs.
- Privacy mode is the default; no per-user views or profiles.
- Tests accompany code; bugs get a regression test.
- Comments say why, not what. No `any`, no dead code, no unused exports.

## Workflow

1. Branch from `main`.
2. Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat(core): …`, `fix(schema): …`).
3. Changed a published package? Run `pnpm changeset` and commit the file it creates.
4. Changed a public API? Run `pnpm api` to refresh the reports in `packages/*/etc/` and commit them. CI fails if they
   are out of date.
5. Changed a collected field, metric or option? Update `packages/schema/src/collected-fields.ts` or `metrics.ts`
   (tests enforce this) and the docs in the same pull request.
6. Made or changed an architectural decision? Add an ADR in `docs/adr/`.

## Deprecation

Deprecate for at least one minor version before removing anything from a public API.
