# @shardlens/schema

The [Shardlens](https://github.com/Kkkermit/Shardlens) wire format as zod schemas, with the JSON Schema for a batch,
the metric registry, and the register of every collected field: what it is, in which mode it is sent, and how long it
is kept.

Use it to validate or generate Shardlens batches. Within a major version the format only grows: fields are never
removed and types are never narrowed.

```ts
import { parseBatch } from '@shardlens/schema';

const result = parseBatch(JSON.parse(body));
if (result.ok) console.log(`${result.events.length} valid events, ${result.errors.length} rejected`);
else console.error(result.issues);
```

## Links

- [What is collected](https://kkkermit.github.io/Shardlens/concepts/data-collected/) ·
  [metrics](https://kkkermit.github.io/Shardlens/concepts/metrics/) ·
  [documentation](https://kkkermit.github.io/Shardlens/)
- Using an AI coding agent? Point it at [`llms.txt`](https://kkkermit.github.io/Shardlens/llms.txt), the docs as plain
  text.
- [Source and issues](https://github.com/Kkkermit/Shardlens) · MIT licence · not affiliated with Discord
