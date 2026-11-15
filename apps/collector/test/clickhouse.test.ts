import { uuidv7 } from '@shardlens/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClickHouseStore, type MirroredCustom, type MirroredInteraction } from '../src/storage/clickhouse.js';

const server = vi.hoisted(() => ({ inserted: [] as { table: string; rows: number }[], refuse: new Set<string>() }));

vi.mock('@clickhouse/client', () => ({
  createClient: () => ({
    async insert({ table, values }: { table: string; values: unknown[] }) {
      if (server.refuse.has(table)) throw new Error('socket hang up');
      server.inserted.push({ table, rows: values.length });
    },
    close: async () => undefined,
  }),
}));

const APP_ID = '1234567890123456789';

const interaction = (): MirroredInteraction => ({
  id: uuidv7(),
  ts: new Date(),
  appId: APP_ID,
  kind: 1,
  command: 'ticket',
  sub: null,
  outcome: 0,
  context: 0,
  install: 0,
  guildId: null,
  locale: 'en-GB',
  tier: null,
  userHash: Buffer.alloc(16),
  ackMs: 120,
  weight: 1,
});

const custom = (): MirroredCustom => ({
  id: uuidv7(),
  ts: new Date(),
  appId: APP_ID,
  name: 'ticket_opened',
  userHash: null,
  guildId: null,
  weight: 1,
});

beforeEach(() => {
  server.inserted.length = 0;
  server.refuse.clear();
});

describe('ClickHouse mirror', () => {
  it('sends interactions once when only the custom-event insert fails', async () => {
    const store = new ClickHouseStore('http://localhost:8123/shardlens');
    store.mirror({ interactions: [interaction()], custom: [custom()] });
    server.refuse.add('custom_events');
    await store.flush();
    server.refuse.clear();
    await store.flush();
    expect(server.inserted).toEqual([
      { table: 'interactions', rows: 1 },
      { table: 'custom_events', rows: 1 },
    ]);
    expect(store.dropped).toBe(0);
    await store.stop();
  });

  it('warns once a minute while ClickHouse is down, with the rows dropped so far', async () => {
    const warnings: string[] = [];
    const store = new ClickHouseStore('http://localhost:8123/shardlens');
    store.start((message) => warnings.push(message));
    server.refuse.add('interactions');
    store.mirror({ interactions: [interaction()], custom: [] });
    for (let i = 0; i < 3; i++) await store.flush();
    store.mirror({ interactions: Array.from({ length: 50_000 }, interaction), custom: [] });
    expect(store.dropped).toBe(50_000);
    expect(warnings).toEqual(['ClickHouse insert failed: socket hang up (0 rows dropped so far)']);
    server.refuse.clear();
    await store.stop();
  });
});
