# Repository rulesets

Branch and tag protection for this repository, kept as files so the settings are reviewable and repeatable.

| File                | What it does                                                                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `main.json`         | `main` can't be deleted or force-pushed, history stays linear, every change arrives through a squash-merged pull request with resolved conversations and passing checks. |
| `release-tags.json` | Tags can be created but never moved or deleted, so a published version always points at the same commit.                                                                 |

## Import

In the repository: **Settings → Rules → Rulesets → New ruleset → Import a ruleset**, then choose a file. Or with the
GitHub CLI:

```sh
gh api -X POST repos/Kkkermit/Shardlens/rulesets --input .github/rulesets/main.json
gh api -X POST repos/Kkkermit/Shardlens/rulesets --input .github/rulesets/release-tags.json
```

Import them after the first push to `main`: the required checks only exist once the workflows have run once.

## Notes

- Approvals are set to zero because a sole maintainer can't approve their own pull request. Raise
  `required_approving_review_count` and turn on `require_code_owner_review` when there is a second maintainer.
- Repository admins may merge a pull request whose checks haven't reported (`bypass_mode: pull_request`). That is for
  the "Version Packages" pull request Changesets opens: GitHub doesn't start workflows for pull requests created with
  the default `GITHUB_TOKEN`. Admins still can't push to `main` directly.
- The required checks are the job names in `.github/workflows/`. Rename a job and this file has to follow, or pull
  requests will wait for a check that never arrives.
- The benchmark, the dependency audit and the nightly compatibility run report on every pull request but are not
  required: they can fail for reasons a pull request didn't cause (a noisy runner, a new advisory, a discord.js
  release).
