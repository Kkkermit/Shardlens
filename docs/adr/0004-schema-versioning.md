# 0004. Wire-format versioning: additive within a major

- Status: Accepted (amended 2026-11-15)
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

## Amendment (2026-11-15): what narrowing means

Simulated installs and a fuzzing pass before the first public release made three points precise.

- **A limit may refuse what the collector could never store.** A number past what its column or a rollup sum holds, a
  NUL character, an ID above 2^63: such a value already failed, and before per-event validation it failed the whole
  request. Refusing it at validation drops only that event. This is how v1 gained caps on histogram buckets, rate-limit
  waits and permission bitfields, and the NUL rule. Anything a collector can store is never narrowed.
- **Every rule is stated in the JSON Schema too.** SDKs in other languages validate against `batch.schema.json`, so a
  check zod runs in code (a `.refine()`) would be invisible to them, and one that throws on bad input fails the
  request. Limits are written as patterns and bounds; the privacy-mode rule (no `actor`) and the NUL rule are added to
  the JSON Schema by `batchJsonSchema()`. A unit test fails on any other refinement.
- **Collector replies may narrow; requests may not.** `ConfigResponse` and the other replies describe what a collector
  promises, so restricting them never breaks an SDK. Sample rates are now at least 1 / `MAX_EVENT_WEIGHT`: a lower one
  gave kept events a `weight` the wire refuses.

## Consequences

- New event types (for example `interaction_error` in M1 and `message_command` in 1.x) are additive and do not need a
  major bump. A collector older than the event type drops it per event, as `invalid_event`, and keeps the rest of the
  batch.
- The SDK tests send everything the adapters build through `parseBatch()`, so an SDK change that the collector would
  refuse fails CI. Per-version golden fixtures are still to come, for when a v2 exists to compare against.
