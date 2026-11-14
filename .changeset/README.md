# Changesets

Every change to a published package (`packages/*`) needs a changeset describing it and the semver bump.

```sh
pnpm changeset
```

Commit the generated Markdown file with your change. On `main`, the release workflow turns pending changesets into a
version pull request; merging that pull request publishes to npm with provenance (see `docs/adr/0008-release-gating.md`).
