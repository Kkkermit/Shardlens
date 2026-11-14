---
'@shardlens/core': patch
'@shardlens/collector': patch
---

Clearer logs. The SDK says once when it can't reach the collector (and once when it is back) instead of only counting
the failure. The collector logs a startup summary, rejected events with their reasons, failed Discord sign-ins and
failed live updates, includes a `requestId` in `500` replies that matches its log line, and records an alert whose
webhook can no longer be decrypted in that alert's history.
