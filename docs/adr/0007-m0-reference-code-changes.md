# 0007. Changes to the spec's reference code during M0

- Status: Accepted
- Date: 2026-11-13

## Context

The spec's reference code (sections 11 and 12) is the starting point, to be kept unless there is a reason. Porting it
with tests turned up a few gaps. Each change below is covered by a test.

## Decision

| Area                   | Reference behaviour                  | Change                                                                                      | Why                                                                                                                                    |
| ---------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `redactSecrets`        | Bot-token first segment `{24,}`      | `{23,}`, plus `Bearer` values and `slk_` keys                                               | Bots with 17-digit IDs have 23-character first segments, so their tokens slipped through; widening redaction is always the safer error |
| `bucketOf`             | `NaN` returned `NaN`                 | `NaN` and negatives go to bucket 0                                                          | A `NaN` index silently corrupts a histogram                                                                                            |
| `quantile`             | Any `q` accepted                     | `RangeError` outside [0, 1]                                                                 | Catches caller bugs early                                                                                                              |
| `BoundedQueue.take`    | Returned items only                  | Returns `{ item, priority }`                                                                | `requeue` needs each item's lane, so the transport can put a failed batch back                                                         |
| `BoundedQueue.requeue` | Dropped requeued items whenever full | Requeued items evict strictly lower-priority items first                                    | Otherwise gauges that arrived during a failed send would push out interactions, breaking the drop-by-priority rule                     |
| Privacy rule           | Described as a collector check       | Also enforced in `@shardlens/schema` (`privacyViolation`, `Batch` refinement, `parseBatch`) | One tested implementation shared by SDK contract tests and the collector                                                               |
| Package outputs        | n/a                                  | ESM `dist/index.js` + `.d.ts`, CJS `dist/index.cjs` + `.d.cts`                              | tsdown's defaults for `"type": "module"`; checked by publint and attw                                                                  |
| `isAllowedEndpoint`    | Rule in prose                        | Function in core; also allows `[::1]` and refuses URLs with credentials                     | Testable; keys never travel in URLs                                                                                                    |

## Consequences

- None of these change the wire format.
