---
'@shardlens/collector': patch
---

Background jobs:

- Rollups no longer miss events that arrive just under two minutes late, or late events committed while a run is
  going on. A value that can't be summed skips only its own statement instead of stopping every rollup.
- Each job runs one at a time, so a slow rollup can't build up a queue.
- Dropping and creating partitions waits at most 2 seconds for a lock, so it can't stall ingest behind a long query.
- Collectors started together on an empty database no longer crash.
- Weekly unique users are counted only for weeks inside one salt period, and final counts are never rewritten.
- A privacy erase no longer waits for a slow copy of the events to empty its whole buffer.
- Live tiles shared between collectors come back after a database restart.
- The next salt is served in the last minutes of a period, for bots whose clocks run slightly ahead.
- Upgrading from 1.0 on a PostgreSQL that isn't set to UTC no longer counts the hours around the upgrade twice: the
  old buckets are moved to UTC.

Dashboard:

- When the session ends, the dashboard goes back to the sign-in page. A failed request shows an error with retry,
  never a false "nothing here".
- Activity pages through every row, and rows sharing a time are no longer skipped.
- Long, right-to-left or emoji names no longer break layouts or reverse the text next to them. Nothing scrolls
  sideways at phone width, and tables can be scrolled with the keyboard.
- Settings sends only the fields you changed and always offers the stored time zone. It also gains SKU prices.
- The Servers list keeps its filters, sort and page in the address.
- Numbers follow the browser's locale consistently. Prefix commands are written without a slash in funnels and
  filters. There are clearer messages for rate limits and refused fields, a skip link, and focus moves to each new
  page's heading.
