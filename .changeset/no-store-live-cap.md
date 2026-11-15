---
'@shardlens/collector': patch
'@shardlens/schema': patch
---

Hardening from a security review:

- API and sign-in answers carry `Cache-Control: no-store` unless a route sets its own (public badges), so no browser
  or proxy cache keeps analytics, keys or, in audit mode, the decrypted activity log.
- One visitor can hold at most 10 of the 100 live-update streams, so a single client (anyone, in demo mode) can't shut
  everyone else out of the live tiles.
- The data-collected register says that team members' IDs are kept as they are, to check a Discord sign-in.
