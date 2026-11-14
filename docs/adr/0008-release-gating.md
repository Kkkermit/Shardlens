# 0008. npm releases stay switched off until trusted publishing is proven

- Status: Accepted
- Date: 2026-11-13

## Context

Releases use npm trusted publishing (OIDC) with provenance, so no npm token is ever stored. That needs setup outside the
repo: the `@shardlens` npm org, a trusted publisher per package, and a protected `npm` GitHub environment. The spec
also asks M0 to prove that `changeset publish` (which calls `pnpm publish`) performs the OIDC exchange.

## Decision

- `.github/workflows/release.yml` only runs when the repository variable `RELEASE_ENABLED` is `true`. Until then a push
  to `main` publishes nothing.
- Packages stay at `0.0.0` until the first changeset.
- Proving OIDC: publish one throwaway scoped package (for example `@shardlens/publish-test`) through the same workflow,
  confirm the provenance badge on npm, then deprecate it. If `pnpm publish` does not perform the exchange, switch the
  workflow's publish step to `npm publish` per package.

## Consequences

- M0's "dry release proves OIDC publishing" criterion needs a maintainer with npm org access; it cannot be done from
  code alone.
