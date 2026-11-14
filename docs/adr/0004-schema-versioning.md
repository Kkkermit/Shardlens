# 0004. Wire-format versioning: additive within a major

- Status: Accepted
- Date: 2026-11-13

## Context

Bot owners upgrade the SDK and the collector at different times. A batch from a newer SDK must not be rejected by an
older collector of the same major, and vice versa.

## Decision

- The wire format lives in `@shardlens/schema` (zod 4) and carries `v` (major version). v1 is frozen at the end of M0.
- Within a major, changes are **additive only**: new optional fields, new event types, wider limits. Never remove or
  rename a field, never narrow a type.
- Objects **strip** unknown keys instead of rejecting them, so a newer SDK's extra fields are ignored by an older
  collector. Stripping also means unexpected data is discarded, never stored.
- The collector accepts the current and the previous major (`ACCEPTED_WIRE_VERSIONS`).
- An invalid envelope rejects the whole batch; an invalid event drops only that event (`parseBatch()`).
- The schema package also emits `batch.schema.json` (JSON Schema, input shape), `metrics.json` and
  `collected-fields.json` for the docs site.
- Every wire field must appear in the data-collected register (`collected-fields.ts`); a unit test enforces this in
  both directions.

## Consequences

- New event types (for example `interaction_error` in M1) are additive and do not need a major bump.
- Golden fixtures per schema version (contract tests) must be added once the collector exists.
