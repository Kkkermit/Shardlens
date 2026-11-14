import type { Shardlens } from '@shardlens/discordjs';
import type { Client } from 'discord.js';

declare const client: Client;
declare const lens: Shardlens;

// The SDK never installs signal handlers. Flush on your own shutdown path.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await lens.shutdown({ timeoutMs: 2_000 }); // gives up after 2 s; never throws
    await client.destroy();
    process.exit(0);
  });
}
