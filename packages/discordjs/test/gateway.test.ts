import { EventEmitter } from 'node:events';
import type { Client } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { listenShardEvents, localShardCount, managerShardCount, shardIds, shardPings } from '../src/gateway.js';

const wrap =
  <A extends unknown[]>(_name: string, fn: (...args: A) => void) =>
  (...args: A) =>
    fn(...args);

/** discord.js 14: `client.ws.shards` collection, shard events on the client. */
function v14Client() {
  const shards = new Map([
    [0, { id: 0, ping: 42 }],
    [1, { id: 1, ping: -1 }],
  ]);
  const client = Object.assign(new EventEmitter(), { ws: { shards } });
  return client as unknown as Client & EventEmitter;
}

/** discord.js 15: `@discordjs/ws` manager on `client.ws`, pings on the client, shard events on `client.ws`. */
function v15Client() {
  const ws = Object.assign(new EventEmitter(), { getShardIds: () => [2, 3], getShardCount: () => 8 });
  const client = Object.assign(new EventEmitter(), { ws, pings: new Map([[2, 55]]) });
  return client as unknown as Client & EventEmitter & { ws: EventEmitter };
}

function recorder() {
  const calls: unknown[][] = [];
  return {
    calls,
    handlers: {
      ready: (shard: number, unavailable: number) => void calls.push(['ready', shard, unavailable]),
      resumed: (shard: number, replayed: number | undefined) => void calls.push(['resumed', shard, replayed]),
      reconnecting: (shard: number) => void calls.push(['reconnecting', shard]),
      disconnected: (shard: number, code: number | undefined) => void calls.push(['disconnected', shard, code]),
      error: (shard: number) => void calls.push(['error', shard]),
    },
  };
}

describe('gateway compatibility (discord.js 14 and 15)', () => {
  it('reads shards and pings from discord.js 14', () => {
    const client = v14Client();
    expect(shardIds(client)).toEqual([0, 1]);
    expect(localShardCount(client)).toBe(2);
    expect(managerShardCount(client)).toBeUndefined();
    expect(shardPings(client)).toEqual([{ shard: 0, ping: 42 }]);
  });

  it('reads shards and pings from discord.js 15', () => {
    const client = v15Client();
    expect(shardIds(client)).toEqual([2, 3]);
    expect(localShardCount(client)).toBe(2);
    expect(managerShardCount(client)).toBe(8);
    expect(shardPings(client)).toEqual([{ shard: 2, ping: 55 }]);
  });

  it('copes with a discord.js 15 client that has not connected yet', () => {
    const ws = {
      getShardIds: () => {
        throw new Error('not connected');
      },
      getShardCount: () => {
        throw new Error('not connected');
      },
    };
    const client = { ws } as unknown as Client;
    expect(shardIds(client)).toEqual([]);
    expect(managerShardCount(client)).toBeUndefined();
    expect(shardPings(client)).toEqual([]);
  });

  it('listens to discord.js 14 shard events on the client, and unsubscribes', () => {
    const client = v14Client();
    const rec = recorder();
    const off = listenShardEvents(client, rec.handlers, wrap, true);
    client.emit('shardReady', 1, new Set(['a', 'b']));
    client.emit('shardResume', 1, 12);
    client.emit('shardReconnecting', 1);
    client.emit('shardDisconnect', { code: 4004 }, 1);
    client.emit('shardError', new Error('x'), 1);
    off();
    client.emit('shardReady', 1, new Set());
    expect(rec.calls).toEqual([
      ['ready', 1, 2],
      ['resumed', 1, 12],
      ['reconnecting', 1],
      ['disconnected', 1, 4004],
      ['error', 1],
    ]);
  });

  it('listens to discord.js 15 shard events on client.ws, and unsubscribes', () => {
    const client = v15Client();
    const rec = recorder();
    const off = listenShardEvents(client, rec.handlers, wrap, false);
    client.ws.emit('ready', { guilds: [{ id: '1' }, { id: '2' }, { id: '3' }] }, 2);
    client.ws.emit('resumed', 2);
    client.ws.emit('closed', 4000, 3);
    client.ws.emit('error', new Error('x'), 3);
    off();
    client.ws.emit('ready', { guilds: [] }, 2);
    expect(rec.calls).toEqual([
      ['ready', 2, 3],
      ['resumed', 2, undefined],
      ['disconnected', 3, 4000],
      ['error', 3],
    ]);
  });
});
