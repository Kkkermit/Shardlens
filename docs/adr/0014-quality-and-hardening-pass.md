# 0014. Pre-release quality and hardening pass

- Status: Accepted
- Date: 2026-11-14

## Context

Before the first public release the whole repository was reviewed for dead code, duplication, unclear names, comment
noise and abuse resistance. Some earlier choices changed as a result.

## Decision

| Topic              | Before                                                                                | Now                                                                                                                                      | Why                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Formatting         | Biome formatted and linted                                                            | Prettier formats (TypeScript, JSON, YAML, Markdown, CSS, Astro); Biome lints and sorts imports; Husky and lint-staged run both on commit | One formatter for every file type in the repository, and contributors get it without setting anything up                     |
| Unused code        | Not checked                                                                           | `knip` runs in `pnpm check`                                                                                                              | Unused files, exports and dependencies fail CI instead of accumulating                                                       |
| Migrations         | node-pg-migrate for PostgreSQL, a second runner for PGlite                            | One runner (`src/migrate.ts`) for both: ordered `.sql` files, one transaction each, a blocking advisory lock, and a check for divergence | One code path instead of two; drops a dependency with open advisories; forward-only, so no destructive "down" SQL is shipped |
| Rate limiting      | Opt-in per route                                                                      | Every route is limited per address (1,200 a minute by default), unknown paths included; sensitive routes keep tighter limits             | A new route can no longer be added without a limit                                                                           |
| Ingest limiter key | The presented key                                                                     | The caller's address                                                                                                                     | A caller could dodge the limit by varying a made-up key                                                                      |
| Ingest auth        | Checked in the handler, after the body was read                                       | Checked in `preParsing`, before the body is read                                                                                         | A caller without a key can't make the collector buffer a megabyte per request                                                |
| Key cache          | Known and unknown keys in one map, cleared when full                                  | Separate maps; only unknown keys are evicted                                                                                             | A flood of made-up keys can't evict real keys and force a lookup per batch                                                   |
| Dashboard CSP      | `img-src` allowed `data:`                                                             | `img-src 'self' https://cdn.discordapp.com`                                                                                              | Nothing in the dashboard uses data URIs                                                                                      |
| Shared helpers     | `errorClass`, `errorCode`, `compact` and the exporter buckets were copied per package | Exported once from `@shardlens/core`                                                                                                     | One definition, tested once                                                                                                  |
| Dashboard routes   | Several pages per file                                                                | One page per file                                                                                                                        | Files are named for the page they hold                                                                                       |

## Consequences

- Contributors run `pnpm format` (or just commit: the hook formats staged files) and `pnpm check` before pushing.
- Migrations are forward-only. Undoing a schema change means writing a new migration.
- A collector refuses to start against a database that has migrations it doesn't know, rather than running old code
  on a newer schema.
- Deployments behind a reverse proxy must set `SHARDLENS_TRUST_PROXY`, or every client shares the proxy's address
  and its rate limit.
