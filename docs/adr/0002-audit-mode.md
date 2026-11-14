# 0002. Audit mode is a two-sided, encrypted, time-limited opt-in

- Status: Accepted
- Date: 2026-11-13

## Context

Some bots legitimately need to know who ran a command: support requests, abuse prevention, moderation audit trails.
That can be part of a bot's stated functionality (Developer Policy rule 15) but must never become profiling (rule 16).

## Decision

Audit mode exists, off by default, with all of these guardrails (spec section 7.3):

1. It needs **both** the SDK option `mode: 'audit'` and the collector setting `apps.mode = 'audit'` plus
   `SHARDLENS_AUDIT_KEY`. A privacy-mode collector rejects actor data; `@shardlens/schema` also rejects any
   privacy-mode batch carrying `actor` or `ownerId` (defence in depth, see `privacyViolation()`).
2. User IDs and names are encrypted with AES-256-GCM using a key held outside the database. Exact-ID lookup uses an
   HMAC lookup key, so no bulk decryption is needed.
3. Retention defaults to 30 days; values above 90 are rejected.
4. Lookup is by exact ID only. "Top users" is limited to 24 hours or 7 days and shows counts only.
5. No page aggregates one user's history into a profile; no cross-app joins.
6. Every audit view, lookup, export and erasure writes an `audit_access_log` row visible in Settings.
7. `forgetUser`, `optOut` and a `/privacy` command template work in both modes.

## Consequences

- Two code paths (privacy and audit) must be tested; a contract test proves privacy batches with actor data are
  rejected.
- Docs must explain when audit mode is appropriate and that bot owners must disclose it in their privacy policy.
