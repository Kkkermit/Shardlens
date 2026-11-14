# 0001. Pseudonymise user IDs in-process with rotating, destroyed salts

- Status: Accepted
- Date: 2026-11-13

## Context

Unique-user counts need a stable per-user key, but Discord's Developer Policy (rules 15, 16 and 19) allows improving an
app only with aggregated or de-identified data, and forbids profiling and re-identification. Discord user IDs are
snowflakes: they are guessable, so an unkeyed hash (plain SHA-256) can be reversed by brute force. Under UK GDPR,
pseudonymised data is still personal data; truly anonymous data is not.

## Decision

- The SDK computes `HMAC-SHA-256(salt, userId)` **inside the bot process**, keeps the first 16 bytes and sends
  `h1:<period>:<32 hex>`. Raw user IDs never leave the process in privacy mode (the default).
- The collector creates a random 32-byte salt per app per period and serves it to authenticated SDKs from
  `GET /v1/config`. The SDK keeps keys for at most the current and previous period.
- Default period: **UTC month**. `week` (ISO) and `day` are available; `day` is strictest but cannot produce weekly or
  monthly unique users.
- After the period ends plus a 7-day grace window, the collector writes final unique counts, drops that period's
  `uniques` partition and sets `salts.secret = NULL`. From then on only counts remain.
- `h1` versions the algorithm; the period in the hash stops hashes being compared across periods by mistake.

## Consequences

- Cross-period user tracking is impossible by design; "returning users" only exist within one salt period.
- Events that arrive before the salt is fetched wait in a small bounded buffer (max 1,000 events, max 60 s), then drop
  with a counter.
- The salt lifecycle must be covered by an integration test that proves the secret is NULL and the partition is gone.
