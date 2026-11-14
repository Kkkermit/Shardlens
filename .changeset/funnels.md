---
'@shardlens/collector': minor
'@shardlens/schema': patch
---

Funnels, a cohort builder and an Events page. Funnels count people who did 2–5 custom events or commands in order
within a window; cohorts group people by when they started and show who came back. Steps are linked by salted hash
inside the collector and only counts leave it. Interaction rollups no longer carry the server: per-server numbers come
from the new `interactions.by_guild` metric, and migration 003 converts existing rollups.
