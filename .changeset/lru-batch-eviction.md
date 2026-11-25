---
'@shardlens/discordjs': patch
---

Half the CPU per interaction on a busy bot. Two maps the SDK writes on every interaction evicted their oldest entry
one at a time, and in V8 each such eviction steps over every slot left by earlier ones, so once the maps were full
(after 20,000 interactions) each write cost time in proportion to their size. They now evict a sixteenth of their
entries at a time. The overhead benchmark went from 40–45 µs to about 21 µs of CPU per interaction, with no change
in memory.
