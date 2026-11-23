---
'@shardlens/collector': patch
---

Batches sent at the same time no longer deadlock. When several shards or processes sent batches at once, two batches
counting the same people could wait on each other in PostgreSQL. One of them then failed, and under steady load the
collector fell behind and refused most batches. Each batch now writes its unique-user rows and late minutes in one
fixed order, and each row once.
