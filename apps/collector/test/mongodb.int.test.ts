import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { BUCKETS, bucketOf, periodLabel, uuidv7 } from '@shardlens/core';
import { Event } from '@shardlens/schema';
import { Binary, BSON, MongoClient, MongoServerError, UUID } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GUILD_EVENT } from '../src/ingest/codes.js';
import { runSalts } from '../src/jobs/scheduler.js';
import { collections, LAYOUT_VERSION } from '../src/storage/mongodb/collections.js';
import { databaseName, type Mongo, openMongo } from '../src/storage/mongodb/connect.js';
import { nextId } from '../src/storage/mongodb/ids.js';
import { MongoStore } from '../src/storage/mongodb/store.js';
import { ensureSalt } from '../src/storage/salts.js';
import type { IngestContext, Store } from '../src/storage/store.js';
import { guildInfo, interaction, mongoStore, snowflakeOnShard } from './harness.js';

const APP = '1234567890123456789';
const MINUTE = 60_000;
const DAY = 86_400_000;
const PERIOD = periodLabel('month', new Date());
const minuteOf = (ms: number) => Math.floor(ms / MINUTE) * MINUTE;
const user = (n: number) => `h1:${PERIOD}:${n.toString(16).padStart(32, '0')}`;

/** MongoDB's own tests: what the shared suites can't see from the HTTP API. */
describe('MongoStore', () => {
  let backing: Awaited<ReturnType<typeof mongoStore>>;
  let store: Store;
  let m: Mongo;

  const context = (overrides: Partial<IngestContext> = {}): IngestContext => ({
    appId: APP,
    env: 'production',
    release: '1.0.0',
    instance: 'test:1',
    shards: [0],
    sdkVersion: '@shardlens/test@1.0.0',
    livePeriods: new Set([PERIOD]),
    now: new Date(),
    ...overrides,
  });
  const write = (events: object[], overrides: Partial<IngestContext> = {}) =>
    store.ingest.write(
      context(overrides),
      events.map((e, index) => ({ index, event: Event.parse(e) })),
    );
  const clear = async () => {
    await Promise.all(Object.values(m.c).map((collection) => collection.deleteMany({})));
    await store.apps.register(APP);
  };

  beforeAll(async () => {
    backing = await mongoStore();
    store = backing.store;
    m = (store as MongoStore).mongo;
    await store.prepare();
    await store.apps.register(APP);
  });
  afterAll(() => backing?.close());

  describe('connection and set-up', () => {
    it('caps its connection pool, unless the connection string sets one', async () => {
      const capped = await openMongo(backing.databaseUrl, 'test', { maxPoolSize: 5 });
      const chosen = await openMongo(`${backing.databaseUrl}?maxPoolSize=3`, 'test', { maxPoolSize: 5 });
      try {
        expect(capped.client.options.maxPoolSize).toBe(5);
        expect(chosen.client.options.maxPoolSize).toBe(3);
      } finally {
        await Promise.all([capped.client.close(), chosen.client.close()]);
      }
    });

    it('is ready on a standalone server, and prepares twice without complaint', async () => {
      await store.ready();
      await store.prepare();
      const names = (await m.db.listCollections().toArray()).map((c) => c.name);
      expect(names.every((n) => n.startsWith('shardlens_'))).toBe(true);
      expect(names).toContain('shardlens_interactions');
    });

    it('makes the indexes once per layout version, so a start finding them made costs one read', async () => {
      expect(await m.c.counters.findOne({ _id: 'index_layout' })).toEqual({ _id: 'index_layout', n: LAYOUT_VERSION });
      const indexes = async () => (await m.c.dirtyBuckets.indexes()).map((i) => i.name);
      await m.c.dirtyBuckets.dropIndex('_id.bucket_1');
      await store.prepare();
      expect(await indexes()).not.toContain('_id.bucket_1');
      // A database made for an older layout gets this one's indexes.
      await m.c.counters.updateOne({ _id: 'index_layout' }, { $set: { n: LAYOUT_VERSION - 1 } });
      await store.prepare();
      expect(await indexes()).toContain('_id.bucket_1');
      expect((await m.c.counters.findOne({ _id: 'index_layout' }))?.n).toBe(LAYOUT_VERSION);
    });

    it('numbers IDs from 1 per sequence, without repeats under concurrency', async () => {
      expect(await nextId(m.c, 'test_a')).toBe('1');
      const ids = await Promise.all(Array.from({ length: 50 }, () => nextId(m.c, 'test_a')));
      expect(new Set(ids).size).toBe(50);
      expect(Math.max(...ids.map(Number))).toBe(51);
      expect(await nextId(m.c, 'test_b')).toBe('1');
    });

    it('calls only a document too large for MongoDB, or one BSON cannot encode, refused input', () => {
      const error = (code: number) => new MongoServerError({ message: 'refused', code });
      expect(store.refusedInput(error(10334))).toBe('10334');
      expect(store.refusedInput(new BSON.BSONError('key a\u0000b must not contain null bytes'))).toBe('BSONError');
      expect(store.refusedInput(error(11000))).toBeUndefined();
      expect(store.refusedInput(error(2))).toBeUndefined();
      expect(store.refusedInput(new Error('connection reset'))).toBeUndefined();
      expect(store.refusedInput(Object.assign(new Error('out of range'), { code: '22003', severity: 'ERROR' }))).toBe(
        undefined,
      );
    });
  });

  describe('ingest', () => {
    beforeEach(clear);

    it('stores a batch once: a retry and concurrent copies come back as duplicates', async () => {
      const events = Array.from({ length: 40 }, (_, i) => interaction(user(i % 8), { ts: Date.now() - i * 1000 }));
      const first = await write(events);
      expect(first).toMatchObject({ accepted: 40, duplicates: 0, rejected: [] });
      expect(first.stored.size).toBe(40);
      const retry = await write(events);
      expect(retry).toMatchObject({ accepted: 0, duplicates: 40 });
      expect(retry.stored.size).toBe(0);

      const more = Array.from({ length: 30 }, (_, i) => interaction(user(i % 5)));
      const results = await Promise.all([1, 2, 3, 4].map(() => write(more)));
      expect(results.reduce((a, r) => a + r.accepted, 0)).toBe(30);
      expect(results.reduce((a, r) => a + r.duplicates, 0)).toBe(90);
      const stored = results.flatMap((r) => [...r.stored]);
      expect(new Set(stored).size).toBe(30);
      expect(stored).toHaveLength(30);
      expect(await m.c.interactions.countDocuments({ appId: APP })).toBe(70);
      // 8 people, everyone and per command, server, language and install type: one document each per day.
      const global = await m.c.uniques.countDocuments({ '_id.scope': 'global' });
      expect(global).toBeGreaterThanOrEqual(8);
      expect(await m.c.uniques.countDocuments({ '_id.scope': 'install', '_id.scopeKey': 'guild' })).toBe(global);
    });

    it('stores the rest of a batch, event by event, when one of its events has a key BSON cannot hold', async () => {
      const events = [
        interaction(user(1), { command: 'edge_kept' }),
        interaction(user(1), { command: 'edge_refused', optionValues: { 'nul\u0000name': 'x' } }),
        { id: uuidv7(), ts: Date.now(), type: 'custom', name: 'edge_refused', props: { 'nul\u0000prop': 1 } },
      ];
      const items = events.map((e, index) => ({ index, event: Event.parse(e) }));
      const error = await store.ingest.write(context(), items).catch((e: unknown) => e);
      expect(store.refusedInput(error)).toBe('BSONError');
      const res = await store.ingest.writeEach(context(), items);
      expect(res).toMatchObject({
        accepted: 1,
        rejected: [
          { index: 1, reason: 'refused_by_database' },
          { index: 2, reason: 'refused_by_database' },
        ],
      });
      expect(res.stored).toEqual(new Set([events[0]!.id]));
      expect((await m.c.interactions.find().toArray()).map((d) => d.command)).toEqual(['edge_kept']);
      expect(await m.c.customEvents.countDocuments()).toBe(0);
    });

    it('hands the analytics store only the events stored now', async () => {
      const events = [interaction(user(1)), { id: uuidv7(), ts: Date.now(), type: 'custom', name: 'x', props: {} }];
      const first = await write(events, { mirror: true });
      expect(first.mirror?.interactions).toEqual([
        expect.objectContaining({ id: events[0]!.id, kind: 1, guildId: '112233445566778899', ackMs: 120, weight: 1 }),
      ]);
      expect(first.mirror?.custom).toEqual([expect.objectContaining({ name: 'x', userHash: null })]);
      expect((await write(events, { mirror: true })).mirror).toEqual({ interactions: [], custom: [] });
    });

    it('rejects hashes of an unknown salt period, and lowers stored IDs', async () => {
      const shouted = interaction(user(1), { id: uuidv7().toUpperCase() });
      const res = await write([interaction('h1:1999-01:00000000000000000000000000000000'), shouted]);
      expect(res).toMatchObject({ accepted: 1, rejected: [{ index: 0, reason: 'unknown_salt_period' }] });
      expect([...res.stored]).toEqual([shouted.id.toLowerCase()]);
    });

    it('leaves NULL fields out, and stores message commands with interactions, without a language or a response', async () => {
      await write([
        interaction(user(1), { sub: undefined, ackMs: undefined, install: undefined, memberTier: undefined }),
        {
          id: uuidv7(),
          ts: Date.now(),
          type: 'message_command',
          command: 'ban',
          options: ['user'],
          channelType: 1,
          memberTier: 'dm',
          user: user(2),
          outcome: 'ok',
          handlerMs: 30,
        },
      ]);
      const slash = await m.c.interactions.findOne({ kind: 1 });
      for (const field of ['sub', 'ackMs', 'install', 'memberTier', 'customId']) {
        expect(slash, field).not.toHaveProperty(field);
      }
      expect(slash).toMatchObject({ release: '1.0.0', options: ['category'], weight: 1 });
      expect(slash?.userHash).toBeInstanceOf(Binary);
      const prefix = await m.c.interactions.findOne({ kind: 9 });
      expect(prefix).toMatchObject({ context: 1, locale: '', premium: false, memberTier: 0, handlerMs: 30 });
      expect(prefix).not.toHaveProperty('ackMs');
      expect(prefix).not.toHaveProperty('guildId');
      expect(prefix).not.toHaveProperty('install');
    });

    it('marks the minute of a late event for the rollups, once per batch however many shards send it', async () => {
      const ts = Date.now() - 20 * MINUTE;
      const late = (id: string) => ({
        id,
        ts,
        type: 'guild_availability',
        guild: '1300000000000000003',
        available: false,
        shard: 0,
      });
      await Promise.all([write([late(uuidv7(ts))]), write([late(uuidv7(ts))]), write([late(uuidv7(ts))])]);
      const marks = await m.c.dirtyBuckets.find({ '_id.appId': APP }).toArray();
      expect(marks).toEqual([{ _id: { appId: APP, bucket: new Date(minuteOf(ts)) }, n: 3 }]);
    });

    it('stores a webhook delivery and a webhook entitlement once, however often Discord retries them', async () => {
      const at = new Date(Date.now() - 1000);
      const delivery = {
        id: uuidv7(at.getTime()),
        ts: at,
        appId: APP,
        type: 'APPLICATION_AUTHORIZED',
        integrationType: 1,
        userHash: Buffer.alloc(16, 0xab),
        actor: null,
        guildId: null,
        scopes: ['applications.commands'],
      };
      await store.webhookEvents.record(delivery);
      await store.webhookEvents.record(delivery);
      const stored = await m.c.webhookEvents.find({ appId: APP }).toArray();
      expect(stored).toHaveLength(1);
      expect(Buffer.from(stored[0]!.userHash!.buffer).toString('hex')).toBe('ab'.repeat(16));
      expect(stored[0]).toMatchObject({
        type: 'APPLICATION_AUTHORIZED',
        integrationType: 1,
        scopes: ['applications.commands'],
      });
      expect(stored[0]).not.toHaveProperty('actorEnc');
      expect(stored[0]).not.toHaveProperty('guildId');

      const entitlement = {
        appId: APP,
        ts: at,
        action: 'create' as const,
        skuId: '700000000000000002',
        entitlementType: 8,
        owner: 'user' as const,
        userHash: Buffer.alloc(16, 0xab),
        guildId: null,
        startsAt: null,
        endsAt: null,
      };
      await store.webhookEvents.recordEntitlement(entitlement);
      await store.webhookEvents.recordEntitlement(entitlement);
      // PostgreSQL's unique key leaves the source out: the gateway's report of the same entitlement is the same row.
      const gateway = await write([
        {
          id: uuidv7(at.getTime()),
          ts: at.getTime(),
          type: 'entitlement',
          action: 'create',
          sku: '700000000000000002',
          entitlementType: 8,
          owner: 'user',
          user: `h1:${PERIOD}:${'ab'.repeat(16)}`,
          startsAt: null,
          endsAt: null,
        },
      ]);
      expect(gateway).toMatchObject({ accepted: 0, duplicates: 1 });
      expect(await m.c.entitlements.find({ appId: APP }).toArray()).toEqual([
        expect.objectContaining({ source: 'webhook', skuId: '700000000000000002', owner: 'user' }),
      ]);
    });

    it('keeps two entitlements bought in the same millisecond, and counts a retried one as a duplicate', async () => {
      const ts = Date.now() - 2 * DAY;
      const entitlement = (n: number) => ({
        id: uuidv7(ts),
        ts,
        type: 'entitlement',
        action: 'create',
        sku: '1300000000000000002',
        entitlementType: 8,
        owner: 'user',
        user: user(n),
        startsAt: null,
        endsAt: null,
      });
      const batch = [entitlement(1), entitlement(2)];
      expect(await write(batch)).toMatchObject({ accepted: 2, duplicates: 0 });
      expect(await write(batch)).toMatchObject({ accepted: 0, duplicates: 2 });
      expect(await m.c.entitlements.countDocuments({ skuId: '1300000000000000002' })).toBe(2);
    });

    it('keeps the newest bot name and SDK health when an older report arrives late', async () => {
      const report = (name: string, ts: number, ids: string[]) => ({
        id: uuidv7(ts),
        ts,
        type: 'app_info',
        name,
        approximateGuildCount: 3,
        approximateUserInstallCount: null,
        approximateUserAuthorizationCount: null,
        dashboardUserIds: ids,
        eventWebhooksStatus: 1,
        skus: [],
        nodeVersion: 'v24.11.0',
        libVersion: '14.22.0',
      });
      const health = (ts: number, queueDepth: number) => ({
        id: uuidv7(ts),
        ts,
        type: 'sdk_health',
        queueDepth,
        dropped: { 'odd.key': 1 },
        failedFlushes: 0,
        internalErrors: {},
      });
      const now = Date.now();
      expect(await store.apps.hasReported(APP)).toBe(false);
      expect(await store.apps.isDashboardUser(APP, '334455667788990011')).toBeUndefined();
      expect(await write([report('Newer name', now, ['334455667788990011']), health(now, 5)])).toMatchObject({
        accepted: 2,
      });
      expect(await write([report('Older name', now - 3_600_000, []), health(now - 3_600_000, 9)])).toMatchObject({
        accepted: 2,
      });
      expect((await store.apps.meta(APP))?.name).toBe('Newer name');
      expect(await store.apps.isDashboardUser(APP, '334455667788990011')).toBe(true);
      expect(await store.apps.isDashboardUser(APP, '445566778899001122')).toBe(false);
      expect(await m.c.appInfo.findOne({ _id: APP })).not.toHaveProperty('approxUserInstalls');
      expect(await m.c.sdkHealth.findOne({ _id: { appId: APP, instance: 'test:1' } })).toMatchObject({
        queueDepth: 5,
        dropped: { 'odd.key': 1 },
      });
      const gauges = await m.c.gauges.find({ '_id.name': 'app.approx_guilds' }).toArray();
      expect(gauges).toHaveLength(2);
    });

    it('keeps the last of a command listed twice, and forgets global commands no longer registered', async () => {
      const registry = (commands: object[]) => ({ id: uuidv7(), ts: Date.now(), type: 'command_registry', commands });
      const cmd = (id: string, name: string, guild?: string) => ({ id, name, type: 1, subcommands: [], guild });
      await write([
        registry([
          cmd('1300000000000000001', 'a'),
          cmd('1300000000000000001', 'b'),
          cmd('1300000000000000009', 'g', '112233445566778899'),
        ]),
      ]);
      await write([registry([cmd('1300000000000000005', 'c')])]);
      const left = await m.c.commandRegistry.find({ '_id.appId': APP }).sort({ name: 1 }).toArray();
      expect(left.map((c) => [c.name, c.guildId])).toEqual([
        ['c', undefined],
        ['g', '112233445566778899'],
      ]);
    });
  });

  describe('servers and snapshots', () => {
    beforeEach(clear);

    const snapshot = (shards: number[], shardCount: number, guilds: string[], ts = Date.now()) => ({
      id: uuidv7(ts),
      ts,
      type: 'guild_snapshot',
      shards,
      shardCount,
      guilds,
    });
    const guilds = () => m.c.guilds.find({ '_id.appId': APP }).toArray();
    const history = () => m.c.guildEvents.find({ '_id.appId': APP }).sort({ '_id.kind': 1 }).toArray();

    it('imports existing servers as a baseline, then detects joins and removals while offline', async () => {
      const [a, b, c] = [snowflakeOnShard(0, 2, 1), snowflakeOnShard(1, 2, 2), snowflakeOnShard(0, 2, 3)];
      await write([snapshot([0], 2, [a]), snapshot([1], 2, [b])]);
      expect(await history()).toEqual([]);
      expect((await guilds()).filter((g) => g.baseline)).toHaveLength(2);
      expect(await m.c.apps.findOne({ _id: APP })).toMatchObject({ shardCount: 2, baselineDone: true });

      // Restart: on shard 0, `a` left and `c` joined while the bot was offline. Shard 1 is untouched.
      await write([snapshot([0], 2, [c])]);
      expect((await history()).map((e) => [e._id.guildId, e._id.kind, e.detectedAtStartup, e.pending])).toEqual([
        [c, GUILD_EVENT.join, true, undefined],
        [a, GUILD_EVENT.leave, true, undefined],
      ]);
      const rows = Object.fromEntries((await guilds()).map((g) => [g._id.guildId, g]));
      expect(rows[b]).not.toHaveProperty('leftAt');
      expect(rows[a]?.leftAt).toBeInstanceOf(Date);
      expect(rows[c]).toMatchObject({ detectedAtStartup: true, baseline: false, name: '', memberCount: 0 });
    });

    it('completes a layout once when its shards report at the same time', async () => {
      await m.c.apps.updateOne({ _id: APP }, { $set: { shardCount: 2, baselineDone: true } });
      const leaving = snowflakeOnShard(0, 4, 41);
      const joining = snowflakeOnShard(1, 4, 42);
      await m.c.guilds.insertOne({
        _id: { appId: APP, guildId: leaving },
        name: 'x',
        memberCount: 1,
        features: [],
        joinedAt: new Date(),
        detectedAtStartup: false,
        baseline: false,
        updatedAt: new Date(),
      });
      const at = Date.now();
      await Promise.all(
        [0, 1, 2, 3].map((shard) =>
          write([snapshot([shard], 4, shard === 1 ? [joining] : [], at + shard)], {
            instance: `host:${shard}`,
            shards: [shard],
          }),
        ),
      );
      expect((await history()).map((e) => [e._id.guildId, e._id.kind])).toEqual([
        [joining, GUILD_EVENT.join],
        [leaving, GUILD_EVENT.leave],
      ]);
      expect(await m.c.snapshotPending.countDocuments()).toBe(0);
      expect(await m.c.leases.countDocuments()).toBe(0);
    });

    it('keeps a server whose profile arrives before the last shard reports as an existing install', async () => {
      const [a, b] = [snowflakeOnShard(0, 2, 31), snowflakeOnShard(1, 2, 32)];
      const update = (guild: string) => ({
        id: uuidv7(),
        ts: Date.now(),
        type: 'guild_update',
        info: guildInfo(guild, { joinedAt: Date.now() - 3 * DAY, name: '$where', icon: null }),
      });
      await write([snapshot([0], 2, [a])]);
      await write([update(a)]);
      await write([snapshot([1], 2, [b]), update(b)]);
      const rows = await guilds();
      expect(rows.map((g) => [g._id.guildId, g.baseline]).sort()).toEqual(
        [
          [a, true],
          [b, true],
        ].sort(),
      );
      // Discord's join time replaces the snapshot's, and text is kept as text.
      expect(rows[0]?.joinedAt.getTime()).toBeLessThan(Date.now() - 2 * DAY);
      expect(rows.every((g) => g.name === '$where' && g.sizeAtJoin === 42 && !('icon' in g))).toBe(true);
    });

    it("waits for another process's snapshot lease by the server's clock, not its own", async () => {
      const guild = snowflakeOnShard(0, 1, 61);
      const lease = `snapshot:${APP}`;
      await m.c.leases.insertOne({ _id: lease, holder: 'another process', expiresAt: new Date(Date.now() + MINUTE) });
      // This bot process's clock runs five minutes ahead of the other's and the server's.
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(Date.now() + 5 * MINUTE);
        const applied = write([snapshot([0], 1, [guild])]);
        await sleep(300);
        const held = await m.c.leases.findOne({ _id: lease });
        const meanwhile = await guilds();
        await m.c.leases.deleteOne({ _id: lease, holder: 'another process' });
        await applied;
        expect(held).toMatchObject({ holder: 'another process' });
        expect(meanwhile).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
      expect((await guilds()).map((g) => g._id.guildId)).toEqual([guild]);
      expect(await m.c.leases.countDocuments()).toBe(0);
    });

    it('waits for every shard of a new layout, and ignores a shard outside it', async () => {
      await m.c.apps.updateOne({ _id: APP }, { $set: { shardCount: 2, baselineDone: true } });
      await write([snapshot([0], 3, [snowflakeOnShard(0, 3, 9)])]);
      await write([snapshot([7], 4, [])]);
      expect(await history()).toEqual([]);
      expect(await m.c.snapshotPending.find().toArray()).toEqual([
        expect.objectContaining({ _id: { appId: APP, shardCount: 3, shard: 0 } }),
      ]);
    });

    it("finishes a new shard layout without undoing the joins and leaves since each shard's snapshot", async () => {
      await m.c.apps.updateOne({ _id: APP }, { $set: { shardCount: 2, baselineDone: true } });
      const leaving = snowflakeOnShard(0, 4, 41);
      const joining = snowflakeOnShard(0, 4, 42);
      await write([{ id: uuidv7(), ts: Date.now() - DAY, type: 'guild_update', info: guildInfo(leaving) }]);
      const at = Date.now() - MINUTE;
      await write([snapshot([0], 4, [leaving], at)]);
      await write([
        {
          id: uuidv7(at + 10_000),
          ts: at + 10_000,
          type: 'guild_join',
          info: guildInfo(joining),
          detectedAtStartup: false,
        },
        { id: uuidv7(at + 20_000), ts: at + 20_000, type: 'guild_leave', guild: leaving, detectedAtStartup: false },
      ]);
      await write([1, 2, 3].map((shard) => snapshot([shard], 4, [], at + 30_000)));
      const rows = Object.fromEntries((await guilds()).map((g) => [g._id.guildId, g]));
      expect(Object.keys(rows).sort()).toEqual([joining, leaving].sort());
      expect(rows[leaving]?.leftAt).toBeInstanceOf(Date);
      expect(rows[joining]).not.toHaveProperty('leftAt');
      expect((await history()).filter((e) => e.detectedAtStartup)).toEqual([]);
    });

    it('counts the commands a server ran before removing the bot, when both arrive in one batch', async () => {
      const [tried, never] = [snowflakeOnShard(0, 1, 71), snowflakeOnShard(0, 1, 72)];
      const at = Date.now() - 2 * MINUTE;
      const event = (offset: number, fields: object) => ({ id: uuidv7(at + offset), ts: at + offset, ...fields });
      const join = (guild: string) =>
        event(0, { type: 'guild_join', info: guildInfo(guild, { joinedAt: at }), detectedAtStartup: false });
      const leave = (guild: string) => event(20_000, { type: 'guild_leave', guild, detectedAtStartup: false });
      const res = await write([
        join(tried),
        join(never),
        leave(tried),
        leave(never),
        interaction(user(9), event(10_000, { guild: tried })),
        interaction(user(9), event(15_000, { guild: tried })),
        interaction(user(9), event(30_000, { guild: tried })),
        interaction(user(9), event(30_000, { guild: never })),
      ]);
      expect(res).toMatchObject({ accepted: 8 });
      const rows = Object.fromEntries((await guilds()).map((g) => [g._id.guildId, g]));
      expect([rows[tried]?.firstCommandAt?.getTime(), rows[tried]?.lastCommandAt?.getTime()]).toEqual([
        at + 10_000,
        at + 15_000,
      ]);
      expect(rows[never]).not.toHaveProperty('firstCommandAt');
      expect(rows[tried]?.sizeAtJoin).toBe(42);
    });

    it("loses no server's first or last command when shards send them at the same time", async () => {
      const guild = snowflakeOnShard(0, 1, 81);
      await write([
        { id: uuidv7(), ts: Date.now() - DAY, type: 'guild_join', info: guildInfo(guild), detectedAtStartup: false },
      ]);
      const base = Date.now() - 10 * MINUTE;
      await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          write([interaction(user(i), { guild, ts: base + i * 1000 })], { instance: `host:${i}` }),
        ),
      );
      const row = await m.c.guilds.findOne({ _id: { appId: APP, guildId: guild } });
      expect([row?.firstCommandAt?.getTime(), row?.lastCommandAt?.getTime()]).toEqual([base, base + 7000]);
    });

    it('applies a join a failed attempt recorded but did not apply, when the batch is retried', async () => {
      const guild = snowflakeOnShard(0, 1, 91);
      const ts = Date.now() - 5000;
      const join = {
        id: uuidv7(ts),
        ts,
        type: 'guild_join',
        info: guildInfo(guild, { name: 'Retried' }),
        detectedAtStartup: false,
      };
      await m.c.guildEvents.insertOne({
        _id: { appId: APP, guildId: guild, ts: new Date(ts), kind: GUILD_EVENT.join },
        detectedAtStartup: false,
        pending: true,
      });
      expect(await write([join])).toMatchObject({ accepted: 0, duplicates: 1 });
      expect(await m.c.guilds.findOne({ _id: { appId: APP, guildId: guild } })).toMatchObject({ name: 'Retried' });
      expect(await m.c.guildEvents.findOne({ '_id.guildId': guild })).not.toHaveProperty('pending');
      // Once applied, a retry changes nothing: a newer leave stays.
      await write([{ id: uuidv7(), ts: ts + 1000, type: 'guild_leave', guild, detectedAtStartup: false }]);
      await write([join]);
      expect((await m.c.guilds.findOne({ _id: { appId: APP, guildId: guild } }))?.leftAt).toBeInstanceOf(Date);
    });
  });

  describe('rollups', () => {
    beforeEach(clear);

    const rollup = (grain: '1m' | '1h' | '1d', filter: object) =>
      m.c[grain === '1m' ? 'rollup1m' : grain === '1h' ? 'rollup1h' : 'rollup1d']
        .find({ appId: APP, ...filter })
        .toArray();
    const hist = (entries: [number, number][]) => {
      const h = new Array<number>(BUCKETS).fill(0);
      for (const [ms, w] of entries) h[bucketOf(ms)]! += w;
      return h;
    };

    it('counts, sums, keeps the extremes and the histogram of a minute, and carries them into its hour and day', async () => {
      const at = minuteOf(Date.now() - 30 * MINUTE);
      const ran = (offset: number, fields: object) =>
        interaction(user(1), { command: 'roll', sub: 'a', ts: at + offset, ...fields });
      await write([
        ran(1000, { ackMs: 120 }),
        // Weight 2.5 adds 2.5 runs, and 2 to the histogram: PostgreSQL rounds half to even.
        ran(2000, { ackMs: 500, weight: 2.5 }),
        ran(3000, { ackMs: undefined }),
        ran(4000, { ackMs: 3000, outcome: 'error' }),
        ran(MINUTE + 1000, { ackMs: 50 }),
      ]);
      await store.jobs.backfillRollups(new Date(at), new Date(at + MINUTE));
      const ok = { metric: 'interactions', 'dims.command': 'roll', 'dims.outcome': 0 };
      const [minute] = await rollup('1m', { ...ok, bucket: new Date(at) });
      expect(minute).toMatchObject({ count: 4.5, sum: 120 + 500 * 2.5, min: 120, max: 500 });
      expect(minute?.hist).toEqual(
        hist([
          [120, 1],
          [500, 2],
        ]),
      );
      expect(minute?.dims).toEqual({
        kind: 1,
        command: 'roll',
        sub: 'a',
        outcome: 0,
        context: 0,
        install: 0,
        locale: 'en-GB',
        tier: 1,
      });
      expect(await rollup('1m', { metric: 'interactions.by_guild', 'dims.command': 'roll' })).toHaveLength(2);

      // The next minute, recomputed on its own, joins the first in their hour and day.
      await store.jobs.backfillRollups(new Date(at + MINUTE), new Date(at + 2 * MINUTE));
      for (const grain of ['1h', '1d'] as const) {
        const [doc] = await rollup(grain, ok);
        expect(doc, grain).toMatchObject({ count: 5.5, sum: 1420, min: 50, max: 500 });
        expect(doc?.hist, grain).toEqual(
          hist([
            [120, 1],
            [500, 2],
            [50, 1],
          ]),
        );
      }
      // Again: nothing doubles.
      await store.jobs.backfillRollups(new Date(at), new Date(at + 2 * MINUTE));
      expect((await rollup('1h', ok))[0]?.count).toBe(5.5);
      expect(await rollup('1m', ok)).toHaveLength(2);

      // A minute that no longer has its events loses its documents, and its hour and day follow.
      await m.c.interactions.deleteMany({ ts: { $gte: new Date(at + MINUTE) } });
      await store.jobs.backfillRollups(new Date(at + MINUTE), new Date(at + 2 * MINUTE));
      expect(await rollup('1m', ok)).toHaveLength(1);
      expect((await rollup('1d', ok))[0]).toMatchObject({ count: 4.5, min: 120 });
    });

    it('puts every latency in the bucket @shardlens/core puts it in', async () => {
      const thresholds: number[] = [];
      for (let ms = 0; thresholds.length < BUCKETS - 1; ms++) {
        while (thresholds.length < BUCKETS - 1 && bucketOf(ms) > thresholds.length) thresholds.push(ms);
      }
      const samples = [...new Set([0, 1, ...thresholds.flatMap((t) => [t - 1, t]), 59_999, 60_000, 600_000])].filter(
        (ms) => ms >= 0,
      );
      const at = minuteOf(Date.now() - 40 * MINUTE);
      await write(samples.map((ackMs, i) => interaction(user(1), { command: 'buckets', ackMs, ts: at + i })));
      await store.jobs.backfillRollups(new Date(at), new Date(at + MINUTE));
      const [doc] = await rollup('1m', { metric: 'interactions', 'dims.command': 'buckets' });
      expect(doc?.hist).toEqual(hist(samples.map((ms) => [ms, 1])));
    });

    it('recomputes a late minute, rolling up events older than minute retention into hours and days only', async () => {
      const late = Date.now() - 40 * MINUTE;
      const old = Date.now() - 20 * DAY;
      await write([
        interaction(user(1), { command: 'late_one', ts: late }),
        interaction(user(1), { command: 'old_one', ts: old }),
      ]);
      expect(await m.c.dirtyBuckets.countDocuments()).toBe(2);
      await store.jobs.runRollups(new Date());
      const n = async (grain: '1m' | '1h' | '1d', command: string) =>
        (await rollup(grain, { metric: 'interactions', 'dims.command': command })).reduce((a, d) => a + d.count, 0);
      expect([await n('1m', 'late_one'), await n('1h', 'late_one'), await n('1d', 'late_one')]).toEqual([1, 1, 1]);
      expect([await n('1m', 'old_one'), await n('1h', 'old_one'), await n('1d', 'old_one')]).toEqual([0, 1, 1]);
      expect(await m.c.dirtyBuckets.countDocuments()).toBe(0);
    });

    it('recomputes the minute of a late message command, as PostgreSQL does', async () => {
      const ts = Date.now() - 20 * MINUTE;
      await write([
        {
          id: uuidv7(ts),
          ts,
          type: 'message_command',
          command: 'late_prefix',
          options: [],
          channelType: 0,
          guild: '112233445566778899',
          user: user(1),
          outcome: 'ok',
        },
      ]);
      await store.jobs.runRollups(new Date());
      const [doc] = await rollup('1m', { metric: 'interactions', 'dims.command': 'late_prefix' });
      expect(doc).toMatchObject({ bucket: new Date(minuteOf(ts)), count: 1, dims: { kind: 9 } });
    });

    it('rolls up an event that arrived just under 2 minutes late, and reaches back when runs fall behind', async () => {
      const arrived = Date.now();
      await write(
        [{ id: uuidv7(arrived - 115_000), ts: arrived - 115_000, type: 'custom', name: 'almost_late', props: {} }],
        {
          now: new Date(arrived),
        },
      );
      await store.jobs.runRollups(new Date(arrived + 90_000));
      expect(await rollup('1m', { metric: 'custom.almost_late' })).toHaveLength(1);

      await write(
        [{ id: uuidv7(arrived - 100_000), ts: arrived - 100_000, type: 'custom', name: 'behind', props: {} }],
        {
          now: new Date(arrived),
        },
      );
      await store.jobs.runRollups(new Date(arrived + 10 * MINUTE), { since: new Date(arrived) });
      expect(await rollup('1m', { metric: 'custom.behind' })).toHaveLength(1);
    });

    it('keeps the mark of a late event that lands while a run is working', async () => {
      const bucket = minuteOf(Date.now() - 30 * MINUTE);
      const late = (offset: number) =>
        write([{ id: uuidv7(bucket + offset), ts: bucket + offset, type: 'custom', name: 'raced', props: {} }]);
      await late(1000);
      // Hold the run at its first day write while a second late event for the same minute arrives.
      const days = m.c.rollup1d;
      const bulkWrite = days.bulkWrite.bind(days);
      let reached: () => void = () => undefined;
      const atDay = new Promise<void>((resolve) => {
        reached = resolve;
      });
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      days.bulkWrite = (async (...args: Parameters<typeof bulkWrite>) => {
        reached();
        await held;
        return bulkWrite(...args);
      }) as typeof days.bulkWrite;
      try {
        const run = store.jobs.runRollups();
        await atDay;
        await late(2000);
        release();
        await run;
      } finally {
        days.bulkWrite = bulkWrite;
      }
      expect(await m.c.dirtyBuckets.countDocuments({ '_id.appId': APP })).toBe(1);
      await store.jobs.runRollups();
      expect((await rollup('1m', { metric: 'custom.raced' }))[0]?.count).toBe(2);
      expect(await m.c.dirtyBuckets.countDocuments()).toBe(0);
    });

    it('finishes the work of a run that failed partway on the next run', async () => {
      const ts = Date.now() - 45 * MINUTE;
      await write([interaction(user(1), { command: 'interrupted', ts })]);
      const hours = m.c.rollup1h;
      const bulkWrite = hours.bulkWrite.bind(hours);
      hours.bulkWrite = (async () => {
        throw new Error('connection lost');
      }) as typeof hours.bulkWrite;
      try {
        await expect(store.jobs.runRollups()).rejects.toThrow('connection lost');
      } finally {
        hours.bulkWrite = bulkWrite;
      }
      const filter = { metric: 'interactions', 'dims.command': 'interrupted' };
      expect(await rollup('1m', filter)).toHaveLength(1);
      expect(await rollup('1h', filter)).toHaveLength(0);
      // The late minute's mark and the failed run's own marks are still there.
      expect(await m.c.dirtyBuckets.countDocuments({ '_id.appId': APP })).toBe(1);
      expect(await m.c.dirtyBuckets.countDocuments({ '_id.appId': '' })).toBeGreaterThanOrEqual(5);
      await store.jobs.runRollups();
      expect((await rollup('1h', filter))[0]?.count).toBe(1);
      expect((await rollup('1d', filter))[0]?.count).toBe(1);
      expect(await m.c.dirtyBuckets.countDocuments()).toBe(0);
    });

    it('skips a metric whose figures overflow, and still rolls up every other metric', async () => {
      const ts = new Date(Date.now() - 20_000);
      for (let i = 0; i < 2; i++) {
        await m.c.rateLimits.insertOne({
          _id: new UUID(uuidv7(ts.getTime())),
          ts,
          appId: APP,
          scope: 'user',
          global: false,
          route: '/poison',
          method: 'POST',
          retryAfter: 1e308,
        });
        await m.c.restCalls.insertOne({
          _id: { eventId: new UUID(uuidv7(ts.getTime())), row: 0 },
          ts,
          appId: APP,
          method: 'GET',
          route: '/saturated',
          status: 200,
          count: 1,
          retries: 0,
          hist: Array.from({ length: 40 }, (_, b) => (b === 16 ? 2 ** 31 - 1 : 0)),
          weight: 1,
        });
      }
      await write([{ id: uuidv7(ts.getTime()), ts: ts.getTime(), type: 'custom', name: 'beside_poison', props: {} }]);
      const { skipped } = await store.jobs.runRollups();
      expect(skipped).toEqual([expect.stringMatching(/^rest\.ratelimits by minute/)]);
      expect(await rollup('1m', { metric: 'rest.ratelimits' })).toEqual([]);
      expect(await rollup('1m', { metric: 'custom.beside_poison' })).toHaveLength(1);
      const [rest] = await rollup('1h', { metric: 'rest.calls', 'dims.route': '/saturated' });
      expect(rest?.hist?.[16]).toBe(2 ** 31 - 1);
      expect(rest?.count).toBe(2);
    });

    it('counts every kind of event as PostgreSQL does', async () => {
      const ts = minuteOf(Date.now() - 50 * MINUTE) + 1000;
      await write([
        interaction(user(1), { kind: 'autocomplete', command: 'find', options: ['query'], ts }),
        interaction(user(1), {
          kind: 'button',
          command: undefined,
          customId: 'ticket:close:*',
          sourceCommand: 'ticket',
          ts,
        }),
        interaction(user(1), { kind: 'modal_submit', command: undefined, customId: 'form', ts }),
        interaction(user(1), { command: 'apply', responseType: 9, ts }),
        {
          id: uuidv7(ts),
          ts,
          type: 'interaction_error',
          interaction: uuidv7(ts),
          command: 'apply',
          errorClass: 'TypeError',
          handlerMs: 40,
        },
        {
          id: uuidv7(ts),
          ts,
          type: 'rest_window',
          windowMs: 10_000,
          rows: [{ method: 'GET', route: '/users/:id', status: 200, count: 3, retries: 1, latency: hist([[80, 3]]) }],
          invalid: { count401: 1, count403: 0, count429: 2, shared429: 0 },
        },
        {
          id: uuidv7(ts),
          ts,
          type: 'rate_limit',
          scope: 'user',
          global: false,
          route: '/x',
          method: 'POST',
          limit: 5,
          retryAfter: 250,
          sublimitTimeout: 0,
        },
        { id: uuidv7(ts), ts, type: 'guild_availability', guild: '1300000000000000003', available: false, shard: 0 },
        {
          id: uuidv7(ts),
          ts,
          type: 'entitlement',
          action: 'create',
          sku: '1300000000000000002',
          entitlementType: 8,
          owner: 'guild',
          guild: '1300000000000000003',
          startsAt: null,
          endsAt: null,
        },
        {
          id: uuidv7(ts),
          ts,
          type: 'subscription',
          action: 'create',
          status: 0,
          skus: ['1300000000000000002'],
          user: user(2),
          periodStart: ts,
          periodEnd: ts + DAY,
        },
        { id: uuidv7(ts), ts, type: 'custom', name: 'signup', props: { plan: 'pro' } },
      ]);
      await store.webhookEvents.record({
        id: uuidv7(ts),
        ts: new Date(ts),
        appId: APP,
        type: 'APPLICATION_AUTHORIZED',
        integrationType: 1,
        userHash: Buffer.alloc(16, 1),
        actor: null,
        guildId: null,
        scopes: ['applications.commands'],
      });
      await store.jobs.backfillRollups(new Date(ts - 1000), new Date(ts + MINUTE));
      const docs = await rollup('1m', {});
      const by = (metric: string) => docs.filter((d) => d.metric === metric).map((d) => [d.dims, d.count, d.sum]);
      expect(by('interactions.autocomplete')).toEqual([[{ command: 'find', option: 'query' }, 1, 120]]);
      expect(by('components')).toEqual([
        [{ kind: 5, custom_id: 'ticket:close:*', source: 'ticket', outcome: 0, guild: '112233445566778899' }, 1, 120],
      ]);
      expect(by('modals.submitted')).toEqual([[{ custom_id: 'form', outcome: 0 }, 1, 120]]);
      expect(by('modals.shown')).toEqual([[{ command: 'apply', custom_id: null }, 1, 0]]);
      expect(by('interactions.errors')).toEqual([[{ command: 'apply', error_class: 'TypeError' }, 1, 40]]);
      expect(by('rest.calls')).toEqual([[{ method: 'GET', route: '/users/:id', status: 200 }, 3, 1]]);
      const invalid = docs.filter((d) => d.metric === 'rest.invalid').map((d) => [d.dims.status, d.count]);
      expect(Object.fromEntries(invalid)).toEqual({ '401': 1, '403': 0, '429': 2, '429_shared': 0 });
      expect(by('rest.ratelimits')).toEqual([[{ scope: 'user', route: '/x' }, 1, 250]]);
      expect(by('guild.unavailable')).toEqual([[{ detected: false }, 1, 0]]);
      expect(by('entitlements')).toEqual([[{ action: 'create', sku: '1300000000000000002', source: 'gateway' }, 1, 0]]);
      expect(by('subscriptions')).toEqual([[{ action: 'create', status: 0 }, 1, 0]]);
      expect(by('custom.signup')).toEqual([[{}, 1, 0]]);
      expect(by('webhook.application_authorized')).toEqual([[{ integration_type: 1 }, 1, 0]]);
      expect(docs.find((d) => d.metric === 'rest.calls')?.hist).toEqual(hist([[80, 3]]));
    });
  });

  describe('salts and unique users', () => {
    beforeEach(clear);
    const seen = async (period: string, day: string, hashes: Buffer[], app = APP, scope = 'global') => {
      await m.c.uniques.insertMany(
        hashes.map((h) => ({
          _id: { appId: app, period, scope, scopeKey: '*', day, userHash: new Binary(h) },
        })),
      );
    };
    const users = (n: number) => Array.from({ length: n }, () => randomBytes(16));
    const counts = (grain: string, startDay: string) =>
      m.c.uniqueCounts.findOne({
        '_id.appId': APP,
        '_id.grain': grain,
        '_id.startDay': startDay,
        '_id.scope': 'global',
      });

    it('counts a week only when it lies inside one salt period, and never rewrites a final count', async () => {
      await ensureSalt(store, APP, '2026-11');
      await ensureSalt(store, APP, '2026-12');
      await seen('2026-11', '2026-11-10', users(4));
      await seen('2026-11', '2026-11-30', users(10));
      await seen('2026-12', '2026-12-01', users(3));
      await store.jobs.runUniques(APP);
      expect(await counts('week', '2026-11-09')).toMatchObject({ users: 4, newUsers: 0 });
      expect(await counts('week', '2026-11-30')).toBeNull();
      expect(await counts('day', '2026-11-10')).toMatchObject({ users: 4, newUsers: 4, final: false });

      await store.jobs.runUniques(APP, '2026-11', true);
      expect(await counts('month', '2026-11-01')).toMatchObject({ users: 14, final: true });
      await m.c.uniques.deleteMany({ '_id.period': '2026-11', '_id.day': '2026-11-30' });
      await store.jobs.runUniques(APP);
      expect(await counts('month', '2026-11-01')).toMatchObject({ users: 14, final: true });
    });

    it('destroys expired salts: final counts kept, that period of that app hashes deleted, the secret gone', async () => {
      const OTHER = '1234567890123456780';
      await store.apps.register(OTHER);
      for (const app of [APP, OTHER]) {
        await m.c.salts.insertOne({
          _id: { appId: app, period: '2020-01' },
          secret: new Binary(Buffer.alloc(32)),
          periodEnd: new Date('2020-02-01'),
          destroyAfter: new Date(app === APP ? '2020-02-08' : '2999-01-01'),
        });
      }
      await ensureSalt(store, APP, PERIOD);
      await seen('2020-01', '2020-01-15', users(1));
      await seen('2020-01', '2020-01-15', users(2), OTHER);
      await seen(PERIOD, `${PERIOD}-01`.slice(0, 10), users(3));
      expect(await runSalts(store, new Date())).toEqual([`${APP}:2020-01`]);
      const salt = await m.c.salts.findOne({ _id: { appId: APP, period: '2020-01' } });
      expect(salt).not.toHaveProperty('secret');
      expect(salt?.destroyedAt).toBeInstanceOf(Date);
      expect(await store.salts.secret(APP, '2020-01')).toBeUndefined();
      expect(await m.c.uniques.countDocuments({ '_id.appId': APP, '_id.period': '2020-01' })).toBe(0);
      expect(await m.c.uniques.countDocuments({ '_id.appId': OTHER, '_id.period': '2020-01' })).toBe(2);
      expect(await m.c.uniques.countDocuments({ '_id.appId': APP, '_id.period': PERIOD })).toBe(3);
      expect(await counts('month', '2020-01-01')).toMatchObject({ users: 1, final: true });
      const live = await store.salts.livePeriods(APP, new Date());
      expect(live.has(PERIOD)).toBe(true);
      expect(live.has('2020-01')).toBe(false);
      expect(await store.salts.liveSecrets(APP)).toHaveLength(live.size);
    });

    it('keeps a salt once stored, whoever stores it first', async () => {
      const salt = (secret: Buffer) => ({
        period: '2030-01',
        secret,
        periodEnd: new Date('2030-02-01'),
        destroyAfter: new Date('2030-02-08'),
      });
      const [first, second] = [randomBytes(32), randomBytes(32)];
      await Promise.all([store.salts.ensure(APP, salt(first)), store.salts.ensure(APP, salt(second))]);
      const kept = await store.salts.alive(APP, ['2030-01', '2031-01'], new Date('2030-01-15'));
      expect(kept).toHaveLength(1);
      expect([first.toString('hex'), second.toString('hex')]).toContain(kept[0]?.secret.toString('hex'));
      expect(await store.salts.alive(APP, ['2030-01'], new Date('2030-02-09'))).toEqual([]);
    });
  });

  describe('retention', () => {
    beforeEach(clear);

    it("deletes what PostgreSQL's daily job deletes, by each app's own settings", async () => {
      const SHORT = '1234567890123456781';
      await store.apps.register(SHORT);
      await store.apps.update(SHORT, { rawRetentionDays: 7 });
      await store.apps.update(APP, { rawRetentionDays: 90 });
      await m.c.settings.insertOne({ _id: { appId: APP, key: 'audit_retention_days' }, value: 3 });
      const now = Date.now();
      const ago = (days: number) => new Date(now - days * DAY);
      const raw = (app: string, days: number) => ({
        _id: new UUID(uuidv7(ago(days).getTime())),
        ts: ago(days),
        appId: app,
        name: `kept_${days}`,
        props: {},
        weight: 1,
      });
      await m.c.customEvents.insertMany([raw(APP, 10), raw(APP, 50), raw(APP, 95), raw(SHORT, 1), raw(SHORT, 10)]);
      await m.c.auditLog.insertMany(
        [1, 5].map((days) => ({
          _id: new UUID(uuidv7(ago(days).getTime())),
          ts: ago(days),
          appId: APP,
          actorLookup: new Binary(Buffer.alloc(32)),
          actorEnc: new Binary(Buffer.alloc(32)),
          kind: 1,
          outcome: 0,
        })),
      );
      await m.c.gauges.insertMany(
        [1, 31].flatMap((days) =>
          ['memory.rss_bytes', 'shard.ping_ms'].map((name) => ({
            _id: { appId: APP, name, shard: -1, instance: 'a', ts: ago(days) },
            value: 1,
          })),
        ),
      );
      const rollupDoc = (bucket: Date, metric: string) => ({
        _id: new Binary(randomBytes(32)),
        appId: APP,
        metric,
        bucket,
        dims: {},
        dimsKey: '{}',
        count: 1,
        sum: 0,
      });
      await m.c.rollup1m.insertMany([
        rollupDoc(ago(1), 'custom.a'),
        rollupDoc(ago(15), 'custom.a'),
        rollupDoc(ago(15), 'rest.calls'),
      ]);
      await m.c.rollup1h.insertMany([rollupDoc(ago(30), 'custom.a'), rollupDoc(ago(420), 'custom.a')]);
      await m.c.rollup1d.insertMany([rollupDoc(ago(1000), 'custom.a')]);
      const guild = (id: string, leftDays?: number) => ({
        _id: { appId: APP, guildId: id },
        name: '',
        memberCount: 0,
        features: [],
        joinedAt: ago(200),
        ...(leftDays === undefined ? {} : { leftAt: ago(leftDays) }),
        detectedAtStartup: false,
        baseline: false,
        updatedAt: ago(1),
      });
      await m.c.guilds.insertMany([
        guild('1300000000000000001'),
        guild('1300000000000000002', 10),
        guild('1300000000000000003', 91),
      ]);
      await m.c.sdkHealth.insertMany(
        [
          ['gone:1', 31],
          ['alive:2', 0],
        ].map(([instance, days]) => ({
          _id: { appId: APP, instance: String(instance) },
          ts: ago(Number(days)),
          shards: [],
          queueDepth: 0,
          dropped: {},
          failedFlushes: 0,
          internalErrors: {},
        })),
      );
      await m.c.snapshotPending.insertOne({ _id: { appId: APP, shardCount: 2, shard: 0 }, guilds: [], ts: ago(2) });
      // The admin side's documents, with the `_id` the driver gives them, whatever type the admin side keeps.
      for (const log of [m.c.adminAudit, m.c.accessLog]) {
        await m.db.collection(log.collectionName).insertMany([
          { ts: ago(400), appId: APP, action: 'old', details: {}, viewerUserId: '0' },
          { ts: ago(10), appId: APP, action: 'new', details: {}, viewerUserId: '0' },
        ]);
      }

      await store.jobs.runRetention(new Date(now));

      const names = async (app: string) =>
        (await m.c.customEvents.find({ appId: app }).toArray()).map((d) => d.name).sort();
      expect(await names(APP)).toEqual(['kept_10', 'kept_50']);
      expect(await names(SHORT)).toEqual(['kept_1']);
      expect((await m.c.auditLog.find().toArray()).map((d) => d.ts.getTime())).toEqual([ago(1).getTime()]);
      expect(await m.c.gauges.countDocuments()).toBe(2);
      expect((await m.c.rollup1m.find().toArray()).map((d) => d.bucket.getTime())).toEqual([ago(1).getTime()]);
      expect((await m.c.rollup1h.find().toArray()).map((d) => d.bucket.getTime())).toEqual([ago(30).getTime()]);
      expect(await m.c.rollup1d.countDocuments()).toBe(1);
      expect((await m.c.guilds.find().toArray()).map((g) => g._id.guildId).sort()).toEqual([
        '1300000000000000001',
        '1300000000000000002',
      ]);
      expect((await m.c.sdkHealth.find().toArray()).map((d) => d._id.instance)).toEqual(['alive:2']);
      expect(await m.c.snapshotPending.countDocuments()).toBe(0);
      expect((await m.c.adminAudit.find().toArray()).map((d) => d.action)).toEqual(['new']);
      expect((await m.c.accessLog.find().toArray()).map((d) => d.action)).toEqual(['new']);
    });
  });

  // Atlas's free tier allows 100 operations a second for every process of a bot together.
  describe('operations', () => {
    beforeEach(clear);

    /** The commands a store sends while `fn` runs, on a client of its own that reports them. */
    const sent = async (fn: (s: Store) => Promise<unknown>): Promise<string[]> => {
      const client = await new MongoClient(backing.databaseUrl, { monitorCommands: true }).connect();
      const db = client.db(databaseName(backing.databaseUrl));
      const names: string[] = [];
      try {
        await db.command({ ping: 1 });
        client.on('commandStarted', (e) => {
          if (e.commandName !== 'endSessions') names.push(e.commandName);
        });
        await fn(new MongoStore({ client, db, c: collections(db) }));
        return names;
      } finally {
        await client.close();
      }
    };
    const flush = (n: number) => {
      const now = Date.now();
      return [
        ...Array.from({ length: n }, (_, i) =>
          interaction(user(i % 7), { guild: i % 2 ? '112233445566778899' : '112233445566778800', ts: now - i * 100 }),
        ),
        { id: uuidv7(), ts: now, type: 'custom', name: 'ticket_opened', props: {}, user: user(1) },
        { id: uuidv7(), ts: now, type: 'gauge_window', gauges: [{ name: 'memory.rss_bytes', value: 1 }] },
        {
          id: uuidv7(),
          ts: now,
          type: 'rest_window',
          windowMs: 5000,
          rows: [
            {
              method: 'POST',
              route: '/interactions/:id/:token/callback',
              status: 204,
              count: n,
              retries: 0,
              latency: new Array(40).fill(0),
            },
          ],
          invalid: { count401: 0, count403: 0, count429: 0, shared429: 0 },
        },
        { id: uuidv7(), ts: now, type: 'sdk_health', queueDepth: 0, dropped: {}, failedFlushes: 0, internalErrors: {} },
      ];
    };

    it('writes an SDK flush in one round trip per collection, however many events it holds', async () => {
      const small = await sent((s) =>
        s.ingest.write(
          context(),
          flush(5).map((e, index) => ({ index, event: Event.parse(e) })),
        ),
      );
      const large = await sent((s) =>
        s.ingest.write(
          context(),
          flush(300).map((e, index) => ({ index, event: Event.parse(e) })),
        ),
      );
      expect(small.sort()).toEqual(['insert', 'insert', 'insert', 'insert', 'insert', 'update', 'update', 'update']);
      expect(large).toHaveLength(small.length);
    });

    it('runs a minute of rollups in a few dozen commands', async () => {
      await write(flush(50));
      const run = await sent((s) => s.jobs.runRollups(new Date()));
      expect(run.length).toBeLessThanOrEqual(30);
      const quiet = await sent((s) => s.jobs.runUniques());
      expect(quiet.length).toBeLessThanOrEqual(1 + 4 * 2);
    });
  });
});
