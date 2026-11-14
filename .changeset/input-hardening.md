---
'@shardlens/collector': patch
'@shardlens/schema': patch
---

Input hardening from a security pass. Strings containing a NUL character and IDs too large for a 64-bit integer are
now refused as invalid (per event on ingest) instead of failing the request, and anything else the database refuses
is answered with 400 rather than 500, so an SDK never retries a poison batch forever. Requests must arrive within 30
seconds, a client that disconnects early no longer produces an error, command names in reports can't add lines or
formatting, the dashboard has a page-not-found view, and wide tables no longer widen the page on a phone.
