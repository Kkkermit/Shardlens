---
'@shardlens/core': minor
---

`collectorName` sets what warnings call the collector ("can't reach …", "connected to …"), for a `fetch` that
answers somewhere other than the endpoint: the SDK's `mongodb` option says MongoDB, not `http://localhost`.
