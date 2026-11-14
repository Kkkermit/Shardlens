# 0005. Pin TypeScript to 6.0.x

- Status: Accepted
- Date: 2026-11-13

## Context

TypeScript 7.0.2 is the latest release (13 Nov 2026), but TypeDoc 0.28's peer range ends at `6.0.x` and API Extractor
7.60 bundles TypeScript 6.0.3. The docs site's generated API reference depends on TypeDoc.

## Decision

- The workspace uses `typescript: ~6.0.3` through the pnpm catalog.
- Compiler flags: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`,
  `erasableSyntaxOnly` (no enums, namespaces or parameter properties, so files run under Node's type stripping).
- `@shardlens/core` compiles with `lib: ["es2023", "webworker"]` and no Node types, so any Node-only API in the core
  is a compile error.

## Consequences

- Renovate must not bump TypeScript past 6.0.x. Revisit when TypeDoc supports 7.
