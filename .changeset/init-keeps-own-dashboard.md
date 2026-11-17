---
'shardlens': patch
---

`shardlens init --force` without `--dashboard` keeps a folder set up for a dashboard of your own as one. With
`--identify-users` added later, it treated it as having no dashboard: it said there was nothing to open and didn't put
the new activity key in `dashboard.env`. It now rewrites `dashboard.env` with the keys added since.
