# Security policy

## Reporting a vulnerability

Please **do not** open a public issue. Report privately through GitHub's private vulnerability reporting:
<https://github.com/Kkkermit/Shardlens/security/advisories/new> (or **Security → Report a vulnerability** on this
repository).

Include what you found, how to reproduce it, and the impact you expect. You should get an acknowledgement within
7 days. We will agree a disclosure date with you and credit you in the advisory unless you prefer otherwise.

## Supported versions

Shardlens is pre-1.0. Only the latest release of each package (and the `main` branch) receives security fixes.

## What we treat as security issues

- Any way for the SDK to send or log a bot token, interaction or webhook token, raw REST path, request headers,
  message content, or (in privacy mode) a raw user ID.
- Re-identification of hashed user IDs, or reading audit-mode data without authorisation.
- Authentication or authorisation bypass in the collector or dashboard (ingest keys, sessions, CSRF, OAuth).
- Injection (SQL, XSS, CSV formula injection), SSRF through alert webhooks, or forged Discord webhook events.
- Denial of service against the host bot caused by the SDK.

## Incident checklist (for maintainers and self-hosters)

Discord's Developer Policy requires notifying Discord and affected users of unauthorised access to API Data.

1. Contain: revoke and rotate affected keys (`slk_` ingest and read keys, `SHARDLENS_AUDIT_KEY`,
   `SHARDLENS_SETTINGS_KEY`, session secret, Discord OAuth client secret); invalidate sessions.
2. Assess: what data was exposed (counts only, hashed IDs, audit-mode data) and for which period.
3. Notify: Discord and affected users, plus your data-protection regulator where the law requires it.
4. Fix, release, and publish a GitHub Security Advisory.
5. Write a short post-incident review.
