---
'shardlens': minor
---

Fixes from installing and running the CLI as a new self-hoster:

- `init --force` no longer breaks a running collector. It used to write a new `.env`, whose new database password locked
  the collector out of PostgreSQL and whose new settings and audit keys made encrypted data unreadable. It now updates
  an existing `.env` in place: it sets the domain and application ID, fills in missing secrets and keeps everything
  else.
- `init` refuses when any file it writes is already in the folder, so it no longer overwrites a project's own
  `docker-compose.yml`, and says which path it couldn't write and why instead of a bare `EACCES`.
- `doctor` no longer sends the ingest key over plain HTTP to a collector that isn't on this machine, doesn't follow
  redirects (it reports where they go), stops at a collector that is down instead of reporting the key as rejected,
  checks that `/healthz` really is a Shardlens collector, and explains failures such as an untrusted certificate (with
  `NODE_EXTRA_CA_CERTS` for Caddy's own CA), DNS, refused connections and timeouts. Run in the folder `init` wrote, it
  reads the collector's `SHARDLENS_PUBLIC_URL`, and it says when it can't read the `.env` there.
- Each command accepts only its own options; a misspelt or misplaced option is an error (exit code 2) instead of being
  ignored. New `--version`, clearer `--help` and `init` next steps.
- `privacy`: `--ids-only` and `--audit-retention` imply `--audit`, and the paragraph now mentions the permission level
  and premium status that are recorded, and that the pseudonymous code changes at least monthly and can't be linked a
  week after each change.
