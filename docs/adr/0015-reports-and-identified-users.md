# 0015. Reports in Discord, and what identified mode may collect

- Status: Accepted
- Date: 2026-11-14

## Context

Bot owners asked for three things: the numbers delivered to a Discord channel, the numbers shown inside a dashboard
they already have, and a clear choice between hashed and identified users. Audit mode ([0002](0002-audit-mode.md))
already recorded who ran an interaction; what it collected and how the choice was presented needed settling.

## Decision

- **Scheduled reports.** The collector posts a daily or weekly summary to a Discord webhook (`reports` table,
  `jobs/reports.ts`). Reports contain counts only, in every mode. Destinations are Discord webhook URLs and nothing
  else, the same allow-list alerts use, stored encrypted and shown masked. Each period gets one delivery attempt.
- **Own dashboard.** No new mechanism: the query endpoint the built-in dashboard uses is the integration point, called
  from the owner's backend with a read key. It is documented as such. The collector still sends no CORS headers and
  the dashboard still can't be framed.
- **Identified users.** Audit mode is the "don't hash" choice. An identified user is exactly a user ID, a username and
  an avatar hash; the display name the wire format used to carry is removed. `auditIncludeProfile` (default `true`)
  replaces `auditIncludeNames` (default `false`); `false` records the ID alone. The avatar is stored in the same
  encrypted blob as the username.

Every guardrail in 0002 stands: both sides must opt in, identities are encrypted with a key outside the database,
retention is 30 days by default and 90 at most, lookups are by exact ID, there is no per-user profile or
`groupBy: user`, and every access is logged.

## Consequences

- Turning on audit mode now records usernames and avatars unless the owner opts out, where it used to record IDs
  unless the owner opted in. The settings page and the docs say so before the switch is made.
- A generic "send to any URL" webhook was not added. It would need its own protection against server-side request
  forgery; owners who want the data elsewhere pull it through the query API.
- The settings page calls the modes "Hashed" and "Identified". The wire format, the API and the SDK keep the names
  `privacy` and `audit`.
