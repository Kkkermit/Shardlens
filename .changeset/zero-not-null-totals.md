---
'@shardlens/collector': patch
---

The `command` and `reliability` queries answer 0, not `null`, for a count or share that is zero while runs happened:
a command that ran 6 times and never succeeded has `ok: 0`, and one that never deferred has `deferRate: 0`. `null`
still means nothing ran in the range, as documented.
