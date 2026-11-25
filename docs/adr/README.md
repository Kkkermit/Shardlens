# Architecture decision records

Decisions that shape Shardlens are written down here so contributors (and coding agents) don't re-argue them.
Each record is short: context, decision, consequences. To change a decision, add a new record that supersedes the old
one rather than editing history.

| ADR                                                  | Title                                                                 | Status   |
| ---------------------------------------------------- | --------------------------------------------------------------------- | -------- |
| [0001](0001-salted-user-hashing.md)                  | Pseudonymise user IDs in-process with rotating, destroyed salts       | Accepted |
| [0002](0002-audit-mode.md)                           | Audit mode is a two-sided, encrypted, time-limited opt-in             | Accepted |
| [0003](0003-storage.md)                              | PostgreSQL by default, partitioned, no extensions                     | Accepted |
| [0004](0004-schema-versioning.md)                    | Wire-format versioning: additive within a major                       | Accepted |
| [0005](0005-typescript-6-pin.md)                     | Pin TypeScript to 6.0.x                                               | Accepted |
| [0006](0006-intents-reverification.md)               | Gateway intents re-verified against Discord's docs                    | Accepted |
| [0007](0007-m0-reference-code-changes.md)            | Changes to the spec's reference code during M0                        | Accepted |
| [0008](0008-release-gating.md)                       | npm releases stay switched off until trusted publishing is proven     | Accepted |
| [0009](0009-rest-response-safety.md)                 | Never read or cancel shared REST response bodies                      | Accepted |
| [0010](0010-m1-collector-decisions.md)               | Collector and dashboard choices made during M1                        | Accepted |
| [0011](0011-m2-privacy-admin-decisions.md)           | Privacy, audit and admin choices made during M2                       | Accepted |
| [0012](0012-embedded-mode-on-pglite.md)              | Run embedded mode on PGlite, not SQLite                               | Accepted |
| [0013](0013-m3-m4-decisions.md)                      | Choices made during M3 and M4                                         | Accepted |
| [0014](0014-quality-and-hardening-pass.md)           | Pre-release quality and hardening pass                                | Accepted |
| [0015](0015-reports-and-identified-users.md)         | Reports in Discord, and what identified mode may collect              | Accepted |
| [0016](0016-corrections-from-simulated-installs.md)  | Corrections from simulated installs                                   | Accepted |
| [0017](0017-version-1.md)                            | Version 1.0 and what it promises                                      | Accepted |
| [0018](0018-message-commands.md)                     | Record message (prefix) commands the bot reports                      | Accepted |
| [0019](0019-event-sinks.md)                          | Copy events into the owner's own database through sinks               | Accepted |
| [0020](0020-optional-dashboard-and-activity-keys.md) | The dashboard is optional, and every number can be read with a key    | Accepted |
| [0021](0021-storage-behind-one-interface.md)         | Put the collector's storage behind one interface                      | Accepted |
| [0022](0022-mongodb-storage-engine.md)               | Store everything in the bot's own MongoDB, as a second storage engine | Accepted |

Early records mention "the spec" and milestones M0 to M4: the private build specification Shardlens was first written
from. It is not part of this repository; these records and the docs site are the public account.

Template: copy [0000-template.md](0000-template.md).
