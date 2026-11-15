# @shardlens/schema

The [Shardlens](https://github.com/Kkkermit/Shardlens) wire format: the batches an SDK sends to a Shardlens collector,
as zod 4 schemas, TypeScript types and a JSON Schema. It also holds the metric registry and the register of every
collected field, with the mode it is sent in and how long it is kept.

You don't need it to add Shardlens to a bot: [`@shardlens/discordjs`](https://www.npmjs.com/package/@shardlens/discordjs)
and [`@shardlens/http`](https://www.npmjs.com/package/@shardlens/http) build these events for you. Use it to validate
batches, to write an SDK for another library or language, or to read what Shardlens collects.

```sh
npm install @shardlens/schema
```

Validate a batch the way the collector does: an invalid envelope refuses the whole batch, and an invalid event is
dropped on its own.

```ts
import { parseBatch } from '@shardlens/schema';

const result = parseBatch(JSON.parse(body));
if (result.ok) console.log(`${result.events.length} events kept, ${result.errors.length} refused`);
else console.error(result.issues);
```

Type what you send with `BatchInput` and `EventInput`, and what you receive with `Batch` and `Event`.

## What's in it

- `parseBatch()`, `Batch`, `Event` and a schema for each event type, such as `InteractionEvent`.
- `@shardlens/schema/batch.schema.json`: the same rules as JSON Schema (draft 2020-12), for SDKs in other languages.
- `METRICS` (also `@shardlens/schema/metrics.json`): every metric the collector computes.
- `COLLECTED_FIELDS` and `RETENTION` (also `@shardlens/schema/collected-fields.json`): every field the wire format can
  carry. A test fails when a field is missing from it.
- `ConfigResponse`, `IngestAccepted` and `ErrorResponse`: the collector replies an SDK depends on.

Within a major version the format only grows: fields are never removed and types are never narrowed, and unknown keys
are dropped, so a newer SDK still talks to an older collector.

## Links

- [What is collected](https://kkkermit.github.io/Shardlens/concepts/data-collected/) ·
  [metrics](https://kkkermit.github.io/Shardlens/concepts/metrics/) ·
  [HTTP API](https://kkkermit.github.io/Shardlens/reference/http-api/) ·
  [documentation](https://kkkermit.github.io/Shardlens/)
- Using an AI coding agent? Point it at [`llms.txt`](https://kkkermit.github.io/Shardlens/llms.txt), the docs as plain
  text.
- [Source and issues](https://github.com/Kkkermit/Shardlens) · MIT licence · not affiliated with Discord
