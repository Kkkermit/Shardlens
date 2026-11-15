# @shardlens/core

The library-agnostic core of the [Shardlens](https://github.com/Kkkermit/Shardlens) SDK: a bounded priority queue,
in-process user hashing, gzip batching, retries, an optional disk spool, secret redaction and the exporter hook. Zero
runtime dependencies and Web-standard APIs only (`fetch`, Web Crypto, `CompressionStream`), so it runs on Node.js
22.12+, Bun, Deno and Cloudflare Workers.

You normally don't install this directly:

- for a gateway bot, use [`@shardlens/discordjs`](https://www.npmjs.com/package/@shardlens/discordjs);
- for an HTTP-interaction bot, use [`@shardlens/http`](https://www.npmjs.com/package/@shardlens/http).

Depend on core to write an adapter for another library, or your own metrics exporter.

## Writing an exporter

An exporter sees every event in-process, before sampling and never with a user. `translateEvent` turns events into the
instruments listed in `EXPORTER_METRICS`, the same ones the Prometheus and OpenTelemetry exporters register.

```ts
import { type MetricSink, type ShardlensExporter, translateEvent } from '@shardlens/core';

const sink: MetricSink = {
  add: (metric, labels, value) => {}, // counters
  record: (metric, labels, seconds) => {}, // histograms
  set: (metric, labels, value) => {}, // gauges
};

export const myExporter: ShardlensExporter = { name: 'mine', observe: (event) => translateEvent(event, sink) };
```

Pass it as `exporters: [myExporter]`. `observe` runs on the bot's hot path: no I/O, and it must not throw.

## Writing an adapter

```ts
import { ShardlensClient, uuidv7 } from '@shardlens/core';

const client = new ShardlensClient({
  endpoint: 'https://shardlens.example.com',
  apiKey: 'slk_ingest_…',
  sdk: { name: 'my-adapter', version: '1.0.0' },
});

// The user ID is hashed in-process with the collector's salt for this period; it is never sent.
const ts = Date.now();
client.enqueueWithUser('112233445566778899', ts, 2, (user) => ({
  id: uuidv7(ts),
  ts,
  type: 'custom',
  name: 'ticket_opened',
  props: {},
  user,
}));

// From your own shutdown code: the SDK never installs signal handlers.
await client.shutdown({ timeoutMs: 2_000 });
```

Events follow the wire format in [`@shardlens/schema`](https://www.npmjs.com/package/@shardlens/schema); the collector
rejects the others one by one. Nothing in the client throws into your code: failures are counted in `client.stats()`
and reported to `client.on('error', …)` listeners.

## Links

- [Documentation](https://kkkermit.github.io/Shardlens/) ·
  [architecture](https://kkkermit.github.io/Shardlens/concepts/architecture/) ·
  [privacy model](https://kkkermit.github.io/Shardlens/concepts/privacy-model/)
- Using an AI coding agent? Point it at [`llms.txt`](https://kkkermit.github.io/Shardlens/llms.txt), the docs as plain
  text.
- [Source and issues](https://github.com/Kkkermit/Shardlens) · MIT licence · not affiliated with Discord
