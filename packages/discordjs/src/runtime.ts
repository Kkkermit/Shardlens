import { hostname } from 'node:os';
import type { monitorEventLoopDelay } from 'node:perf_hooks';
import { type SourceInfo, uuidv7 } from '@shardlens/core';
import type { EventInput } from '@shardlens/schema';
import { type Client, version as djsVersion, Routes } from 'discord.js';
import { localShardCount, managerShardCount, shardIds, shardPings } from './gateway.js';
import { shardOf } from './guilds.js';

/** Shards (and cluster) this process owns: discord-hybrid-sharding, ShardingManager, or internal sharding. */
export function detectSource(client: Client, instance: string): SourceInfo {
  const cluster = (client as unknown as { cluster?: { id?: unknown; shardList?: unknown } }).cluster;
  const wsShards = shardIds(client);
  if (cluster && typeof cluster.id === 'number') {
    const list = Array.isArray(cluster.shardList) ? cluster.shardList.filter((s) => typeof s === 'number') : wsShards;
    return { shards: list, cluster: cluster.id, instance };
  }
  if (client.shard) return { shards: [...client.shard.ids], instance };
  return { shards: wsShards, instance };
}

export function defaultInstance(): string {
  return `${hostname()}:${process.pid}`.slice(0, 128);
}

/** Total shard count across all processes, for `(guild_id >> 22) % count`. */
export function totalShards(client: Client): number {
  const fromShardUtil = client.shard?.count;
  if (typeof fromShardUtil === 'number' && fromShardUtil > 0) return fromShardUtil;
  const configured = (client.options as { shardCount?: unknown }).shardCount;
  if (typeof configured === 'number' && configured > 0) return configured;
  return managerShardCount(client) ?? Math.max(1, localShardCount(client));
}

export function ownsShardZero(client: Client): boolean {
  return shardIds(client).includes(0);
}

export function gaugeWindow(client: Client, loop: ReturnType<typeof monitorEventLoopDelay> | undefined): EventInput {
  const mem = process.memoryUsage();
  const perShard = new Map<number, number>();
  for (const g of client.guilds.cache.values()) {
    const shard = shardOf(g);
    perShard.set(shard, (perShard.get(shard) ?? 0) + 1);
  }
  const gauges: { name: string; shard?: number; value: number }[] = [
    ...shardPings(client).map((s) => ({ name: 'shard.ping_ms', shard: s.shard, value: s.ping })),
    ...shardIds(client).map((id) => ({ name: 'shard.guilds', shard: id, value: perShard.get(id) ?? 0 })),
    { name: 'memory.rss_bytes', value: mem.rss },
    { name: 'memory.heap_used_bytes', value: mem.heapUsed },
    { name: 'cache.users', value: client.users.cache.size },
    { name: 'cache.channels', value: client.channels.cache.size },
  ];
  if (loop) {
    const p99 = loop.percentile(99) / 1e6;
    if (Number.isFinite(p99)) gauges.push({ name: 'eventloop.p99_ms', value: p99 });
    loop.reset();
  }
  return { id: uuidv7(), ts: Date.now(), type: 'gauge_window', gauges: gauges.slice(0, 500) };
}

/** `app_info` with Discord's approximate counts, SKUs, dashboard allow-list and the identify budget (shard 0 only). */
export async function appInfo(client: Client<true>): Promise<EventInput> {
  const app = await client.application.fetch();
  const owner = app.owner;
  const dashboardUserIds = !owner
    ? []
    : 'members' in owner
      ? [...owner.members.values()].filter((m) => Number(m.membershipState) === 2).map((m) => m.user.id)
      : [owner.id];
  const skus = await app.fetchSKUs().catch(() => undefined);
  const gateway = (await client.rest.get(Routes.gatewayBot()).catch(() => undefined)) as
    { session_start_limit?: { remaining?: number; total?: number } } | undefined;
  const limit = gateway?.session_start_limit;
  return {
    id: uuidv7(),
    ts: Date.now(),
    type: 'app_info',
    name: String(app.name ?? 'unknown').slice(0, 100),
    approximateGuildCount: app.approximateGuildCount ?? null,
    approximateUserInstallCount: app.approximateUserInstallCount ?? null,
    approximateUserAuthorizationCount: app.approximateUserAuthorizationCount ?? null,
    dashboardUserIds: dashboardUserIds.slice(0, 100),
    eventWebhooksStatus: app.eventWebhooksStatus ?? null,
    skus: skus
      ? [...skus.values()].slice(0, 200).map((s) => ({ id: s.id, name: s.name.slice(0, 100), type: Number(s.type) }))
      : [],
    ...(typeof limit?.remaining === 'number' ? { sessionStartRemaining: limit.remaining } : {}),
    ...(typeof limit?.total === 'number' ? { sessionStartTotal: limit.total } : {}),
    nodeVersion: process.version.slice(0, 32),
    libVersion: String(djsVersion).slice(0, 32),
  };
}

/** Global commands and their subcommands, so the dashboard can list registered-but-unused commands. */
export async function commandRegistry(client: Client<true>): Promise<EventInput> {
  const commands = await client.application.commands.fetch();
  return {
    id: uuidv7(),
    ts: Date.now(),
    type: 'command_registry',
    commands: [...commands.values()].slice(0, 5000).map((c) => ({
      id: c.id,
      name: c.name.slice(0, 32),
      type: Number(c.type),
      ...(c.guildId ? { guild: c.guildId } : {}),
      subcommands: (c.options ?? [])
        .filter((o) => Number(o.type) === 1 || Number(o.type) === 2)
        .flatMap((o) => {
          const nested = 'options' in o && Array.isArray(o.options) ? o.options : [];
          return Number(o.type) === 2 && nested.length > 0
            ? nested.map((s: { name: string }) => `${o.name} ${s.name}`.slice(0, 65))
            : [o.name.slice(0, 65)];
        }),
    })),
  };
}
