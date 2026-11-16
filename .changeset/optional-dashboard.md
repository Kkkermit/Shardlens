---
'@shardlens/collector': minor
---

The dashboard is optional, and nothing is kept for it alone.

- `SHARDLENS_DASHBOARD=off` (`dashboard: false` for an embedded collector) serves the API without the dashboard
  pages, for a dashboard of your own or none. Ingest, queries, jobs, reports and alerts carry on; their Discord
  messages no longer link to a dashboard.
- Activity keys (`slk_activity_…`, scope `activity`) read the activity log and top users in audit mode from the
  server side of your own dashboard, and everything a read key reads. Create one under **Settings → API keys**, or
  set `SHARDLENS_ACTIVITY_KEY`; an embedded collector returns one as `activityKey`. Each read is written to the
  access log under the key's label. A read key is answered with `403 activity_key_required`; exporting, settings and
  key management still need a Discord sign-in.
- `SHARDLENS_MODE` (`mode` for an embedded collector) chooses hashed or identified users in the collector's own
  configuration, which is how audit mode is chosen without a Settings page. When it is set, Settings shows the mode
  and can't change it.
