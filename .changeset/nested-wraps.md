---
'@shardlens/discordjs': patch
---

Wrapped handlers inside one another (a wrapped listener calling a wrapped command, or a framework's wrap around
yours) now record one run: the outermost is timed, and the first error any of them throws is kept. Before, an outer
handler that caught an inner one's error could erase it, and an inner one finishing could send the row early with
only its own time.
