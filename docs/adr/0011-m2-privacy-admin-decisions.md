# 0011. Privacy, audit and admin choices made during M2

- Status: Accepted
- Date: 2026-11-13

## Context

M2 added erasure, audit mode, settings, keys, alerts, Discord webhook events, the `/privacy` command and the CLI.
These are the decisions the spec left open or that changed while building and testing.

## Decisions

| Area                     | Decision                                                                                                                                                                                                            | Why                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Who can administer       | Settings, keys, alerts, erasure from the dashboard and all audit views need a **Discord** session (owner, team or `SHARDLENS_EXTRA_ADMINS`). Read-key sessions are view-only                                        | Audit access must be attributable to a person (`audit_access_log.viewer_user_id`); a read key is not a person |
| Erasure scope            | Deletes raw rows by hash (every live salt period), unique-user rows, webhook and premium rows, and in audit mode the encrypted activity log, owner and installer records. Rolled-up **counts** stay                 | Counts are anonymous; recomputing every affected rollup would rewrite history for no privacy gain             |
| SDK erasure              | The SDK sends hashes for each installed salt; a raw ID is accepted from the SDK only in audit mode (400 otherwise). Admins may erase by exact ID; the collector hashes it itself                                    | Matches spec 13 item 8 without ever widening what privacy mode sends                                          |
| Access log contents      | Lookups record the HMAC lookup key, not the looked-up ID                                                                                                                                                            | The log should prove who searched, without itself becoming a list of identities                               |
| Audit export             | Needs both the CSRF header and `x-shardlens-confirm: export-audit-log` (else 428)                                                                                                                                   | Re-confirmation (spec 7.3) that a link, image or form post can't satisfy                                      |
| Audit rows and retention | Written only when the batch and the app are both in audit mode with the key set, and only within audit retention (1–90 days, larger rejected)                                                                       | Older audit partitions don't exist: an out-of-window row must never fail the batch                            |
| Webhook events           | Verified over the raw body, answered `204` before processing, processed from a bounded queue; the stored ID is derived from the body, so Discord's retries are stored once                                          | Discord retries for 10 minutes and doesn't guarantee order                                                    |
| Webhook user IDs         | Hashed in the collector with the same HMAC and salt the SDK uses                                                                                                                                                    | An install and later commands by the same person line up within a salt period                                 |
| Alerts                   | Components V2 message with `with_components=true`, falling back to plain content on 400; mentions disabled; redirects refused; URL re-checked against the allow-list before every send; 30-minute debounce per rule | Untested Discord edge cases must degrade, never fail open                                                     |
| `/privacy erase`         | Opts the user out **and** erases                                                                                                                                                                                    | Someone asking for deletion almost always wants recording to stop too                                         |
| Opt-outs                 | Held in memory; `optedOut` seeds them and `onOptOutChange` lets the bot persist them                                                                                                                                | The SDK has no storage of its own                                                                             |
| Hash cache               | `UserHasher` caches up to 20,000 `label+user → hash` results, cleared whenever the salt set changes                                                                                                                 | Halved per-interaction CPU (59 → 28 µs); a stale hash can never outlive its salt (regression test)            |
| Free-text redaction      | Custom-event strings, allow-listed option values, custom IDs and server names pass through `redactSecrets` **before** normalisation                                                                                 | The 10,000-token fuzz test found that normalising first broke the token pattern and let a segment through     |
| CLI templates            | `shardlens init` ships the repository's compose file and Caddyfile, minus the build-from-source block                                                                                                               | One source of truth for deployment files                                                                      |

## Consequences

- `apps/collector/test/admin.int.test.ts` covers the webhook receiver, admin gating, settings validation, keys, alerts,
  audit mode end to end, erasure and an auth check on every route.
- `packages/discordjs/test/chaos.test.ts` and `privacy.test.ts` cover the SDK side (chaos, erasure, opt-outs, fuzzing).
