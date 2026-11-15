import { type Client, Events } from 'discord.js';

/**
 * Gateway access that works on discord.js 14 and 15 through public APIs only. In 14, `client.ws` has a `shards`
 * collection and shard events are client events; in 15, `client.ws` is `@discordjs/ws`'s manager, pings are in
 * `client.pings` and shard events are emitted on `client.ws` with the shard ID as the last argument.
 */

interface LegacyWs {
  shards?: { keys(): Iterable<number>; values(): Iterable<{ id: number; ping: number }>; size: number };
}
interface ModernWs {
  getShardIds?: () => number[] | Promise<number[]>;
  getShardCount?: () => number | Promise<number>;
  on?: (event: string, listener: (...args: never[]) => void) => unknown;
  off?: (event: string, listener: (...args: never[]) => void) => unknown;
}

const legacyShards = (client: Client) => (client.ws as unknown as LegacyWs).shards;
const modern = (client: Client) => client.ws as unknown as ModernWs;

/** True on discord.js 14, where shard events are client events. */
const legacyShardEvents = (Events as Record<string, unknown>).ShardReady !== undefined;

/** Shard IDs this client runs. Empty before login (v15 has no shards until it connects). */
export function shardIds(client: Client): number[] {
  const shards = legacyShards(client);
  if (shards && typeof shards.keys === 'function') return [...shards.keys()];
  try {
    const ids = modern(client).getShardIds?.();
    return Array.isArray(ids) ? ids : [];
  } catch {
    return [];
  }
}

export function localShardCount(client: Client): number {
  const shards = legacyShards(client);
  if (shards && typeof shards.size === 'number') return shards.size;
  return shardIds(client).length;
}

/** Total shard count the gateway manager knows (all processes), when it knows it. */
export function managerShardCount(client: Client): number | undefined {
  if (legacyShards(client)) return undefined;
  try {
    const count = modern(client).getShardCount?.();
    return typeof count === 'number' && count > 0 ? count : undefined;
  } catch {
    return undefined;
  }
}

/** Latest heartbeat latency per shard, in milliseconds (shards without one yet are left out). */
export function shardPings(client: Client): { shard: number; ping: number }[] {
  const shards = legacyShards(client);
  if (shards && typeof shards.values === 'function') {
    return [...shards.values()].filter((s) => s.ping >= 0).map((s) => ({ shard: s.id, ping: s.ping }));
  }
  const pings = (client as unknown as { pings?: Map<number, number> }).pings;
  if (!pings || typeof pings.entries !== 'function') return [];
  return [...pings.entries()].filter(([, ping]) => ping >= 0).map(([shard, ping]) => ({ shard, ping }));
}

interface ShardHandlers {
  /**
   * `unavailableGuilds`: servers still unavailable when the shard became ready (discord.js 14 only). `guilds`: the
   * server IDs in the shard's READY payload, every server the shard holds in this session.
   */
  ready(shard: number, unavailableGuilds: number | undefined, guilds: string[] | undefined): void;
  resumed(shard: number, replayed: number | undefined): void;
  reconnecting(shard: number): void;
  disconnected(shard: number, closeCode: number | undefined): void;
  error(shard: number): void;
}

/** Subscribes on whichever emitter this discord.js version uses. Returns a function that unsubscribes. */
export function listenShardEvents(
  client: Client,
  handlers: ShardHandlers,
  wrap: <A extends unknown[]>(name: string, fn: (...args: A) => void) => (...args: A) => void,
  legacy: boolean = legacyShardEvents,
): () => void {
  const subscriptions: [{ on?: ModernWs['on']; off?: ModernWs['off'] }, string, (...args: never[]) => void][] = [];
  const add = <A extends unknown[]>(
    emitter: { on?: ModernWs['on']; off?: ModernWs['off'] },
    event: string,
    fn: (...args: A) => void,
  ) => {
    if (typeof emitter.on !== 'function') return;
    const listener = wrap(event, fn) as unknown as (...args: never[]) => void;
    emitter.on.call(emitter, event, listener);
    subscriptions.push([emitter, event, listener]);
  };

  if (legacy) {
    // discord.js 14's event names (the values of `Events.Shard*`), so this never depends on the enum.
    const c = client as unknown as ModernWs;
    // `shardReady` doesn't carry the READY payload, and the cache keeps servers removed while the shard was away.
    const readyGuilds = new Map<number, string[]>();
    add(c, 'raw', (packet: { t?: unknown; d?: { guilds?: unknown } } | undefined, shard: number) => {
      if (packet?.t === 'READY') readyGuilds.set(shard, guildIds(packet.d?.guilds));
    });
    add(c, 'shardReady', (shard: number, unavailable?: Set<string>) => {
      const guilds = readyGuilds.get(shard);
      readyGuilds.delete(shard);
      handlers.ready(shard, unavailable?.size ?? 0, guilds);
    });
    add(c, 'shardResume', (shard: number, replayed: number) => handlers.resumed(shard, replayed));
    add(c, 'shardReconnecting', (shard: number) => handlers.reconnecting(shard));
    add(c, 'shardDisconnect', (event: { code?: number } | undefined, shard: number) =>
      handlers.disconnected(shard, event?.code),
    );
    add(c, 'shardError', (_error: unknown, shard: number) => handlers.error(shard));
  } else {
    const ws = modern(client);
    // Fired on READY, before discord.js has the servers: every one is still unavailable, so there is no count.
    add(ws, 'ready', (data: { guilds?: unknown } | undefined, shard: number) =>
      handlers.ready(shard, undefined, guildIds(data?.guilds)),
    );
    add(ws, 'resumed', (shard: number) => handlers.resumed(shard, undefined));
    add(ws, 'closed', (code: number, shard: number) => handlers.disconnected(shard, code));
    // No `error` listener: `client.ws` is an EventEmitter, and a listener would stop a fatal gateway error (an invalid
    // token on re-identify, say) from crashing the bot, as it does without Shardlens. Its close code is recorded above.
  }
  return () => {
    for (const [emitter, event, listener] of subscriptions) emitter.off?.call(emitter, event, listener);
  };
}

function guildIds(guilds: unknown): string[] {
  if (!Array.isArray(guilds)) return [];
  return guilds.map((g: { id?: unknown } | null) => g?.id).filter((id): id is string => typeof id === 'string');
}
