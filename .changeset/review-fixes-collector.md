---
'@shardlens/collector': patch
---

Fixes from a full review of the collector and dashboard:

- Rollup days are UTC even when PostgreSQL runs in another time zone.
- A second embedded collector in one process gets its own unique-user partitions instead of failing batches.
- A collector that fails to start (port in use) stops the jobs and live updates it had started.
- Live tiles: a broken listening connection is released, large updates are split instead of dropped, retried
  batches are counted once, and slow databases no longer pile up refreshes.
- The job scheduler keeps one lock connection and one error listener, and releases the lock it may win after stopping.
- Retried server-availability events and late, older `app_info` reports no longer change stored data.
- Testing an alert whose stored webhook can't be decrypted answers 502, not 500.
- ClickHouse: a failed custom-event insert no longer sends interactions twice, and warnings come once a minute with the
  dropped count.
- Dashboard: the overview chart is no longer rebuilt every second, funnel rows with a repeated step render correctly,
  button groups and status messages are announced properly, and dates follow the app's time zone.
