---
'@shardlens/schema': patch
---

The data-collected register no longer says the cluster ID is stored: the collector receives it with each batch and
drops it.
