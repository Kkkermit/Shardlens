# 0020. The dashboard is optional, and every number can be read with a key

- Status: Accepted
- Date: 2026-11-16

## Context

Owners who already run a web dashboard or admin panel for their bot asked to show Shardlens numbers there instead of
sending staff to a second place, and some want no dashboard at all. Three things stood in the way:

- The collector always served the dashboard, and `shardlens init` assumed it.
- Reading the numbers meant hand-writing `fetch` calls against `POST /v1/query`.
- Who ran what (audit mode) could only be read by a person signed in to the Shardlens dashboard with Discord
  ([0015](0015-reports-and-identified-users.md)), and audit mode could only be chosen in its Settings. A panel of the
  owner's own could show every count but never the activity log.

## Decision

- **Three setups, one SDK.** `shardlens init --dashboard shardlens | own | none`. `own` and `none` set
  `SHARDLENS_DASHBOARD=off`: the collector serves its API and nothing else, and alert and report messages carry no
  dashboard link. Embedded mode takes `dashboard: false`. Ingest, queries, jobs, reports and alerts don't depend on
  the choice, and it can be changed back with one setting.
- **`@shardlens/client`.** A typed, dependency-free client (Web APIs only) with one method per query kind, `meta()`,
  `live()` and `activity.*`. The dashboard and the client ask the same API, so nothing is kept for the dashboard alone.
  A type test in the collector keeps the client's query types in step with the zod schema.
- **Activity keys.** A third key scope, `slk_activity_…`, reads `GET /v1/audit/log` and `GET /v1/audit/top-users`
  and everything a read key reads. It exists because a server has no Discord sign-in. The guardrails of audit mode
  are unchanged: identities stay encrypted at rest, a user is looked up by exact ID only, nothing groups by user, and
  every read goes to the access log, under the key (`audit_access_log.viewer_key_id`). A read key is answered with
  `403 activity_key_required`. An activity key cannot export the log, read the access log, change settings, manage
  keys or sign in to the dashboard: changing things still needs a person signed in with Discord.
- **The mode can come from the collector's configuration.** `SHARDLENS_MODE` (`mode` in embedded mode) decides hashed
  or identified users where there is no Settings page. Whoever sets it controls the collector's environment and
  already holds `SHARDLENS_AUDIT_KEY`, so this grants nothing new. When it is set, Settings shows the mode and refuses
  to change it, so the two can't disagree. `init --identify-users` writes it only with `--dashboard own` or `none`;
  with the Shardlens dashboard the switch stays in Settings.

## Alternatives considered

- **Let read keys read the activity log.** Read keys are pasted into scripts and CI and sign in to the dashboard
  read-only; making each of them a key to personal data would widen every existing key. A separate scope keeps the
  common key harmless.
- **An admin key that can do everything.** It would cover settings, alerts and reports for headless collectors, but a
  leaked one could turn audit mode on, create keys and read everything. Reading is what other dashboards need; changes
  stay behind a person.
- **Per-user views in the client.** Out of scope in every mode ([0002](0002-audit-mode.md)): the client exposes
  what the Activity page exposes and nothing more.

## Consequences

- A leaked activity key exposes up to 90 days of who ran what until it is revoked. The docs say to keep it on a
  server, behind the owner's own sign-in, and the access log shows each read under the key's label.
- Alerts and reports are still created in the Shardlens dashboard. A collector running without it keeps sending the
  ones already set up; setting up new ones means turning the dashboard on.
- `SHARDLENS_DASHBOARD=off` leaves the sign-in routes in place. They do nothing useful without the pages, and
  leaving them means turning the dashboard back on needs no other change.
