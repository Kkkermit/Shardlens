---
'@shardlens/collector': minor
---

Find who ran into a failure. A server's page lists the commands that fail there, and in audit mode it and each
command's page link to the Activity log narrowed to their failed runs.

- `GET /v1/audit/log` and its CSV export take `outcome`: `failed` (every outcome but `ok`), `error`, `timeout`,
  `no_response` or `ok`. Two indexes that hold only failures keep the newest ones quick to read in a large log.
- The Activity log's filters are in the address, so other tools can link to it:
  `/activity?guild=<server ID>&command=<name>&outcome=failed`. A user ID is never part of the address.
- Dashboard addresses are plain text. A Discord ID in a hand-written link used to be read as a number and rounded to
  another ID; links made before this change still open.
