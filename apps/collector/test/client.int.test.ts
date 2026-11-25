import { generateKeyPairSync, sign } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  createShardlensClient,
  type LiveUpdate,
  type Meta,
  type QueryResults,
  type QuerySpec,
  type ShardlensClient,
  ShardlensClientError,
} from '@shardlens/client';
import { uuidv7 } from '@shardlens/core';
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import {
  APP_ID,
  envelope,
  guildInfo,
  type Harness,
  INGEST_KEY,
  ingest,
  interaction,
  READ_KEY,
  sdkHasher,
  startHarness,
} from './harness.js';

// The client's result types are written by hand. Each schema below is checked to be the same type as the client's
// (by `tsc`), and every answer of a real collector is parsed with it, strictly: a field the collector adds, drops,
// renames or sends as another type fails here until the client's types say so too.

const time = z.iso.datetime();
const day = z.iso.date();
/** A point's start in the query's time zone, without an offset. */
const localTime = z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/);
const count = z.number().nonnegative();
const keyCount = z.strictObject({ key: z.string(), value: count });
const nullableKeyCount = z.strictObject({ key: z.string().nullable(), value: count });
const sdkInstance = z.strictObject({
  instance: z.string(),
  ts: time,
  shards: z.array(z.number()),
  queueDepth: z.number(),
  dropped: z.record(z.string(), z.number()),
  failedFlushes: z.number(),
  internalErrors: z.record(z.string(), z.number()),
  sdkVersion: z.string().nullable(),
});
const serverProfile = z.strictObject({
  id: z.string(),
  name: z.string(),
  icon: z.string().nullable(),
  memberCount: z.number(),
  sizeAtJoin: z.number().nullable(),
  large: z.boolean().nullable(),
  locale: z.string().nullable(),
  features: z.array(z.string()),
  premiumTier: z.number().nullable(),
  boosts: z.number().nullable(),
  verificationLevel: z.number().nullable(),
  nsfwLevel: z.number().nullable(),
  mfaLevel: z.number().nullable(),
  createdAt: time.nullable(),
  joinedAt: time,
  leftAt: time.nullable(),
  shard: z.number().nullable(),
  channelCounts: z.record(z.string(), z.number()).nullable(),
  roleCount: z.number().nullable(),
  emojiCount: z.number().nullable(),
  stickerCount: z.number().nullable(),
  botPermissions: z.string().nullable(),
  detectedAtStartup: z.boolean(),
  baseline: z.boolean(),
  firstCommandAt: time.nullable(),
  lastCommandAt: time.nullable(),
  updatedAt: time,
});

const Results = {
  series: z.strictObject({
    timezone: z.string(),
    source: z.literal('clickhouse').exactOptional(),
    points: z.array(z.strictObject({ t: localTime, key: z.string().nullable(), value: z.number().nullable() })),
  }),
  top: z.strictObject({
    rows: z.array(
      z.strictObject({
        key: z.string(),
        value: z.number().nullable(),
        count,
        name: z.string().nullable().exactOptional(),
        icon: z.string().nullable().exactOptional(),
      }),
    ),
  }),
  heatmap: z.strictObject({
    timezone: z.string(),
    source: z.literal('clickhouse').exactOptional(),
    cells: z.array(
      z.strictObject({ weekday: z.number().min(1).max(7), hour: z.number().min(0).max(23), value: count }),
    ),
  }),
  commands: z.strictObject({
    periodStart: day,
    rows: z.array(
      z.strictObject({
        command: z.string(),
        runs: count,
        previousRuns: count,
        changePct: z.number().nullable(),
        errorRate: z.number().nullable(),
        p95Ms: z.number().nullable(),
        servers: count,
        lastUsed: time.nullable(),
        uniqueUsersThisPeriod: z.number().nullable(),
        registered: z.boolean(),
        kinds: z.array(z.string()),
      }),
    ),
  }),
  command: z.strictObject({
    from: time,
    totals: z.strictObject({
      runs: z.number().nullable(),
      ok: z.number().nullable(),
      error: z.number().nullable(),
      timeout: z.number().nullable(),
      noResponse: z.number().nullable(),
      deferRate: z.number().nullable(),
      ephemeralRate: z.number().nullable(),
      premiumShare: z.number().nullable(),
      over3sRate: z.number().nullable(),
      handlerP95Ms: z.number().nullable(),
      firstSeen: time.nullable(),
      lastSeen: time.nullable(),
    }),
    latencyHistogram: z.array(z.number()).length(40).nullable(),
    kinds: z.array(keyCount),
    subcommands: z.array(keyCount),
    options: z.array(keyCount),
    optionValues: z.array(z.strictObject({ option: z.string(), value: z.string(), runs: count })),
    memberTiers: z.array(nullableKeyCount),
    installs: z.array(nullableKeyCount),
    contexts: z.array(nullableKeyCount),
    channelTypes: z.array(keyCount),
    locales: z.array(keyCount),
    topServers: z.array(
      z.strictObject({ key: z.string(), value: count, name: z.string().nullable(), icon: z.string().nullable() }),
    ),
    components: z.array(z.strictObject({ key: z.string().nullable(), kind: z.string(), value: count })),
    modals: z.array(z.strictObject({ customId: z.string(), shown: count, submitted: count })),
  }),
  servers: z.strictObject({
    total: count,
    rows: z.array(
      z.strictObject({
        id: z.string(),
        name: z.string(),
        icon: z.string().nullable(),
        memberCount: z.number(),
        boosts: z.number().nullable(),
        premiumTier: z.number().nullable(),
        locale: z.string().nullable(),
        features: z.array(z.string()),
        joinedAt: time,
        leftAt: time.nullable(),
        shard: z.number().nullable(),
        lastActive: time.nullable(),
        detectedAtStartup: z.boolean(),
        baseline: z.boolean(),
        runs: count,
      }),
    ),
  }),
  server: z.discriminatedUnion('found', [
    z.strictObject({ found: z.literal(false) }),
    z.strictObject({
      found: z.literal(true),
      profile: serverProfile,
      events: z.array(
        z.strictObject({
          ts: time,
          kind: z.enum(['join', 'leave', 'unavailable', 'available']),
          detectedAtStartup: z.boolean(),
        }),
      ),
      uniqueUsersThisPeriod: z.number().nullable(),
      periodStart: day,
      missingPermissions: z.string().nullable(),
    }),
  ]),
  growth: z.strictObject({
    daily: z.array(
      z.strictObject({
        day,
        joins: z.number().nullable(),
        leaves: z.number().nullable(),
        joinsDetected: z.number().nullable(),
        leavesDetected: z.number().nullable(),
      }),
    ),
    sizeAtInstall: z.array(
      z.strictObject({ bucket: z.enum(['1-10', '11-100', '101-1k', '1k-10k', '10k+']), servers: count }),
    ),
    activation: z.strictObject({ joined: count, activated: count, rate: z.number().nullable() }),
    installs: z.strictObject({ active: count, inactive: count }),
    cohorts: z.array(z.strictObject({ cohort: day, week: z.number(), servers: count })),
    lifetimes: z.array(z.strictObject({ bucket: z.enum(['<1d', '1-7d', '7-30d', '30-90d', '90d+']), servers: count })),
    approximateGuilds: z.array(z.strictObject({ day, value: z.number() })),
    serverCount: z.strictObject({
      ours: count,
      discord: z.number().nullable(),
      at: time.nullable(),
      drift: z.number().nullable(),
      warn: z.boolean(),
    }),
  }),
  audience: z.strictObject({
    daily: z.array(z.strictObject({ day, users: count, newUsers: count })),
    weekly: z.array(z.strictObject({ week: day, users: count })),
    periods: z.array(z.strictObject({ period: day, users: count, final: z.boolean() })),
    stickiness: z.number().nullable(),
    splits: z.partialRecord(z.enum(['locale', 'install', 'context', 'tier']), z.array(nullableKeyCount)),
    premiumShare: z.number().nullable(),
  }),
  overview: z.strictObject({
    app: z
      .strictObject({
        id: z.string(),
        name: z.string(),
        mode: z.enum(['privacy', 'audit']),
        saltPeriod: z.enum(['day', 'week', 'month']),
        timezone: z.string(),
        rawRetentionDays: z.number(),
      })
      .nullable(),
    appInfo: z
      .strictObject({
        ts: time,
        name: z.string(),
        approxGuilds: z.number().nullable(),
        approxUserInstalls: z.number().nullable(),
        approxUserAuthorizations: z.number().nullable(),
        eventWebhooksStatus: z.number().nullable(),
        sessionStartRemaining: z.number().nullable(),
        sessionStartTotal: z.number().nullable(),
        nodeVersion: z.string().nullable(),
        libVersion: z.string().nullable(),
        sdkVersion: z.string().nullable(),
        release: z.string().nullable(),
      })
      .nullable(),
    sdkInstances: z.array(sdkInstance),
    runs30d: z.array(z.strictObject({ day, runs: count, failures: z.number().nullable() })),
    servers: count,
    uniqueUsersThisPeriod: z.number().nullable(),
    periodStart: day,
    lastEventAt: time.nullable(),
    checklist: z.strictObject({
      receivingEvents: z.boolean(),
      appInfoReceived: z.boolean(),
      webhookEventsEnabled: z.boolean(),
      requiredPermissionsSet: z.boolean(),
    }),
  }),
  gauge: z.strictObject({
    timezone: z.string(),
    points: z.array(z.strictObject({ t: localTime, shard: z.number().nullable(), value: z.number(), max: z.number() })),
  }),
  bursts: z.strictObject({
    rows: z.array(z.strictObject({ minute: time, runs: count, median: count })),
  }),
  reliability: z.strictObject({
    from: time,
    totals: z.strictObject({
      runs: z.number().nullable(),
      missedDeadlines: z.number().nullable(),
      noResponse: z.number().nullable(),
      errors: z.number().nullable(),
      over3sRate: z.number().nullable(),
      p50Ms: z.number().nullable(),
      p95Ms: z.number().nullable(),
      p99Ms: z.number().nullable(),
    }),
    errorsByCode: z.array(keyCount),
    routes: z.array(
      z.strictObject({
        method: z.string(),
        route: z.string(),
        calls: count,
        failures: z.number().nullable(),
        retries: count,
        p95Ms: z.number().nullable(),
      }),
    ),
    rateLimits: z.array(
      z.strictObject({ scope: z.string(), route: z.string(), count, maxRetryAfter: z.number().nullable() }),
    ),
    invalidBudget: z.strictObject({ used: count, limit: z.number(), share: z.number(), shared429: count }),
    identify: z
      .strictObject({
        remaining: z.number().nullable(),
        total: z.number().nullable(),
        nodeVersion: z.string().nullable(),
        libVersion: z.string().nullable(),
        sdkVersion: z.string().nullable(),
        release: z.string().nullable(),
        ts: time,
      })
      .nullable(),
    shards: z.array(z.strictObject({ shard: z.number(), ping: z.number(), ts: time, stale: z.boolean() })),
    shardEvents: z.array(
      z.strictObject({
        ts: time,
        shard: z.number(),
        state: z.string(),
        closeCode: z.number().nullable(),
        replayed: z.number().nullable(),
      }),
    ),
    process: z.partialRecord(
      z.enum(['eventloop.p99_ms', 'memory.rss_bytes', 'memory.heap_used_bytes', 'cache.users', 'cache.channels']),
      z.number(),
    ),
    sdkInstances: z.array(sdkInstance),
  }),
  premium: z.strictObject({
    changes: z.array(
      z.strictObject({ sku: z.string(), name: z.string(), action: z.string(), count, testCount: count }),
    ),
    activeEntitlements: z.array(z.strictObject({ sku: z.string(), name: z.string(), active: count })),
    subscriptions: z.array(
      z.strictObject({
        sku: z.string(),
        name: z.string(),
        active: count,
        ending: count,
        inactive: count,
        price: z.strictObject({ amount: z.number(), currency: z.string() }).nullable(),
      }),
    ),
    premiumShare: z.number().nullable(),
    estimatedMonthlyRevenue: z.record(z.string(), z.number()),
    pricesConfigured: z.boolean(),
  }),
  installs: z.strictObject({
    daily: z.array(z.strictObject({ day, userInstalls: count, userRemovals: count, serverInstalls: count })),
    scopes: z.array(z.strictObject({ scope: z.string(), installs: count })),
    approximateUserInstalls: z.array(z.strictObject({ day, value: z.number() })),
    webhookStatus: z.number().nullable(),
  }),
  events: z.strictObject({
    rows: z.array(z.strictObject({ name: z.string(), count, users: count, lastSeen: time })),
  }),
  eventProps: z.union([
    z.strictObject({ name: z.string(), keys: z.array(z.strictObject({ key: z.string(), count })) }),
    z.strictObject({
      name: z.string(),
      prop: z.string(),
      values: z.array(z.strictObject({ value: z.string(), count })),
    }),
  ]),
  funnel: z.strictObject({
    windowHours: z.number(),
    timezone: z.string(),
    steps: z.array(
      z.strictObject({
        label: z.string(),
        type: z.enum(['event', 'command']),
        name: z.string(),
        users: count,
        medianSeconds: z.number().nullable(),
      }),
    ),
    cohorts: z.array(z.strictObject({ day, users: z.array(count) })),
  }),
  retention: z.strictObject({
    interval: z.enum(['day', 'week']),
    timezone: z.string(),
    start: z.string(),
    return: z.string(),
    periods: z.number(),
    cohorts: z.array(z.strictObject({ cohort: day, size: count, retained: z.array(count) })),
  }),
} satisfies Record<QuerySpec['kind'], z.ZodType>;

const MetaSchema = z.strictObject({
  appId: z.string(),
  name: z.string(),
  mode: z.enum(['privacy', 'audit']),
  saltPeriod: z.enum(['day', 'week', 'month']),
  timezone: z.string(),
  rawRetentionDays: z.number(),
  auditKeyConfigured: z.boolean(),
  discordLogin: z.boolean(),
  webhookEventsConfigured: z.boolean(),
});

const LiveSchema = z.strictObject({
  ts: time,
  perMinute: count,
  errors15m: count,
  perSecond: z.array(count),
  p95Ms5m: z.number().nullable(),
  shards: z.array(z.strictObject({ shard: z.number(), ping: z.number(), fresh: z.boolean() })),
  activeShards: count,
  staleShards: z.array(z.number()),
  servers: count,
});

/** Parses a collector's answer with the schema of its kind: a mismatch names the field. */
function checked<K extends keyof typeof Results>(kind: K, answer: QueryResults[K]): QueryResults[K] {
  const parsed = Results[kind].safeParse(answer);
  expect(parsed.error?.issues, `${kind} answer`).toBeUndefined();
  return answer;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const GUILD_A = '112233445566778899';
const GUILD_B = '223344556677889900';
const SKU = '1300000000000000002';
const [ALICE, BOB, CAROL, DAVE] = [
  '300000000000000001',
  '300000000000000002',
  '300000000000000003',
  '300000000000000004',
];
const { publicKey, privateKey } = generateKeyPairSync('ed25519');

let h: Harness;
let url: string;
let client: ShardlensClient;
const now = Date.now();
// On a whole minute, so that runs seeded seconds apart are counted in the same one.
const t0 = Math.floor((now - 3 * HOUR) / MINUTE) * MINUTE;
const at = (minutes: number) => t0 + minutes * MINUTE;
const range = { from: new Date(t0 - HOUR).toISOString(), to: new Date(now + MINUTE).toISOString() };

/** One of everything the SDK sends, so that every list in every answer has a row to check. */
async function seed() {
  const { hasher, period } = await sdkHasher(h.app);
  const hash = async (userId: string) => (await hasher.hash(userId, period)) as string;
  const [alice, bob, carol, dave] = await Promise.all([ALICE, BOB, CAROL, DAVE].map(hash));
  const event = (ts: number, type: string, fields: Record<string, unknown>) => ({
    id: uuidv7(ts),
    ts,
    type,
    ...fields,
  });
  const run = (user: string | undefined, minutes: number, overrides: Record<string, unknown> = {}) =>
    interaction(user as string, { id: uuidv7(at(minutes)), ts: at(minutes), guild: GUILD_A, ...overrides });
  const latency = new Array<number>(40).fill(0);
  latency[20] = 10;
  const failedRun = run(bob, 30, { outcome: 'error', errorClass: 'TypeError' });

  const events = [
    event(at(0), 'guild_join', { info: guildInfo(GUILD_A, { joinedAt: at(0) }), detectedAtStartup: false }),
    event(at(1), 'guild_join', {
      info: guildInfo(GUILD_B, { name: 'Second server', joinedAt: at(1), preferredLocale: 'de' }),
      detectedAtStartup: false,
    }),
    event(at(10), 'guild_availability', { guild: GUILD_A, available: false, shard: 0 }),
    event(at(11), 'guild_availability', { guild: GUILD_A, available: true, shard: 0 }),
    event(at(0), 'shard_state', { shard: 0, state: 'ready' }),
    event(at(5), 'shard_state', { shard: 0, state: 'disconnected', closeCode: 1006 }),
    event(at(6), 'shard_state', { shard: 0, state: 'resumed', replayed: 3 }),
    event(at(2), 'command_registry', {
      commands: [
        { id: '1100000000000000001', name: 'ticket', type: 1, subcommands: ['open'] },
        { id: '1100000000000000002', name: 'legacy-stats', type: 1 },
      ],
    }),

    run(alice, 20, {
      optionValues: { category: 'billing' },
      channelType: 0,
      premium: true,
      deferred: true,
      ephemeral: true,
      responseType: 5,
      handlerMs: 300,
      shard: 0,
    }),
    failedRun,
    event(at(30) + 500, 'interaction_error', {
      interaction: failedRun.id,
      command: 'ticket',
      errorClass: 'RangeError',
      handlerMs: 40,
    }),
    run(carol, 40, { guild: GUILD_B, locale: 'de', outcome: 'timeout', errorCode: 10062, ackMs: 3400 }),
    run(dave, 45, {
      guild: undefined,
      install: 'user',
      context: 1,
      memberTier: 'dm',
      outcome: 'no_response',
      ackMs: undefined,
    }),
    // A command that opens a modal, the modal's submission, and a button on the ticket command's message.
    run(alice, 50, { command: 'settings', sub: undefined, options: [], responseType: 9, customId: 'settings:modal' }),
    run(alice, 51, {
      kind: 'modal_submit',
      command: undefined,
      sub: undefined,
      options: [],
      customId: 'settings:modal',
    }),
    run(alice, 52, { command: 'ticket', responseType: 9, customId: 'ticket:details' }),
    run(alice, 53, {
      kind: 'modal_submit',
      command: undefined,
      sub: undefined,
      options: [],
      customId: 'ticket:details',
    }),
    run(bob, 54, {
      kind: 'button',
      command: undefined,
      sub: undefined,
      options: [],
      customId: 'ticket:close:*',
      componentType: 2,
      sourceCommand: 'ticket',
    }),
    // Twelve runs in one minute against one or two in the others: a burst.
    ...Array.from({ length: 12 }, (_, i) =>
      interaction([alice, bob, carol][i % 3] as string, {
        id: uuidv7(at(60) + i * 1000),
        ts: at(60) + i * 1000,
        guild: GUILD_A,
        command: 'ping',
        sub: undefined,
        options: [],
      }),
    ),
    event(at(65), 'message_command', {
      command: 'ban',
      options: [],
      guild: GUILD_A,
      memberTier: 'admin',
      user: bob,
      outcome: 'ok',
      handlerMs: 12,
    }),

    event(at(20), 'custom', {
      name: 'ticket_opened',
      props: { category: 'billing', priority: 2 },
      user: alice,
      guild: GUILD_A,
    }),
    event(at(35), 'custom', { name: 'ticket_opened', props: { category: 'support' }, user: bob, guild: GUILD_A }),
    event(at(70), 'custom', { name: 'ticket_closed', props: { resolved: true }, user: alice, guild: GUILD_A }),

    event(now - 2 * MINUTE, 'rest_window', {
      windowMs: 60_000,
      rows: [
        { method: 'POST', route: '/interactions/:id/:token/callback', status: 204, count: 10, retries: 0, latency },
        { method: 'POST', route: '/channels/:id/messages', status: 429, count: 1, retries: 1, latency },
      ],
      invalid: { count401: 0, count403: 2, count429: 1, shared429: 1 },
    }),
    event(now - 2 * MINUTE, 'rate_limit', {
      scope: 'user',
      global: false,
      route: '/channels/:id/messages',
      method: 'POST',
      limit: 5,
      retryAfter: 1200,
      sublimitTimeout: 0,
    }),
    event(now - 3 * MINUTE, 'gauge_window', {
      gauges: [
        { name: 'shard.ping_ms', shard: 0, value: 42 },
        { name: 'shard.guilds', shard: 0, value: 2 },
        { name: 'memory.rss_bytes', value: 180_000_000 },
        { name: 'eventloop.p99_ms', value: 12 },
      ],
    }),
    event(now - 3 * MINUTE, 'sdk_health', {
      queueDepth: 1,
      dropped: { queue_full: 0 },
      failedFlushes: 0,
      internalErrors: { listener: 1 },
    }),
    event(now - 3 * MINUTE, 'app_info', {
      name: 'Client test bot',
      approximateGuildCount: 2,
      approximateUserInstallCount: 5,
      approximateUserAuthorizationCount: 6,
      dashboardUserIds: [],
      eventWebhooksStatus: 2,
      skus: [{ id: SKU, name: 'Pro', type: 5 }],
      sessionStartRemaining: 990,
      sessionStartTotal: 1000,
      nodeVersion: 'v24.11.0',
      libVersion: '14.28.1',
    }),
    event(at(25), 'entitlement', {
      action: 'create',
      sku: SKU,
      entitlementType: 8,
      owner: 'user',
      user: alice,
      startsAt: null,
      endsAt: null,
    }),
    event(at(25), 'subscription', {
      action: 'create',
      status: 0,
      skus: [SKU],
      user: alice,
      periodStart: at(25),
      periodEnd: at(25) + 30 * 24 * HOUR,
    }),
  ];
  const stored = await ingest(h.app, envelope(events));
  expect(stored.statusCode).toBe(202);
  expect(stored.json()).toMatchObject({ accepted: events.length, rejected: [] });
  // In a batch of its own, as a removal an hour and a half later would arrive.
  const left = await ingest(
    h.app,
    envelope([event(at(90), 'guild_leave', { guild: GUILD_B, detectedAtStartup: false })]),
  );
  expect(left.json()).toMatchObject({ accepted: 1, rejected: [] });

  // A user install, as Discord's webhook reports it.
  const install = Buffer.from(
    JSON.stringify({
      version: 1,
      application_id: APP_ID,
      type: 1,
      event: {
        type: 'APPLICATION_AUTHORIZED',
        timestamp: new Date(at(15)).toISOString(),
        data: { integration_type: 1, scopes: ['applications.commands'], user: { id: DAVE, username: 'dave' } },
      },
    }),
  );
  const ts = String(Math.floor(Date.now() / 1000));
  const delivered = await h.app.inject({
    method: 'POST',
    url: '/v1/discord/events',
    headers: {
      'content-type': 'application/json',
      'x-signature-ed25519': sign(null, Buffer.concat([Buffer.from(ts), install]), privateKey).toString('hex'),
      'x-signature-timestamp': ts,
    },
    payload: install,
  });
  expect(delivered.statusCode).toBe(204);

  // What Settings would hold: a required permission the bot lacks in these servers, and a price for the SKU.
  await h.store.settings.set(APP_ID, 'required_permissions', '8192');
  await h.store.settings.set(APP_ID, 'sku_prices', { [SKU]: { amount: 4.99, currency: 'USD' } });

  await h.store.jobs.backfillRollups(new Date(t0 - HOUR), new Date(now + MINUTE));
  await h.store.jobs.runUniques();
}

beforeAll(async () => {
  h = await startHarness({
    discordPublicKey: Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url').toString('hex'),
  });
  await h.app.listen({ port: 0, host: '127.0.0.1' });
  url = `http://127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;
  client = createShardlensClient({ endpoint: url, apiKey: READ_KEY });
  await seed();
});

afterAll(async () => {
  await h?.close();
});

describe('@shardlens/client against a real collector', () => {
  it('declares, for every kind, the type its answer is checked against', () => {
    expectTypeOf<{ [K in keyof typeof Results]: z.infer<(typeof Results)[K]> }>().toEqualTypeOf<QueryResults>();
    expectTypeOf<z.infer<typeof MetaSchema>>().toEqualTypeOf<Meta>();
    expectTypeOf<z.infer<typeof LiveSchema>>().toEqualTypeOf<LiveUpdate>();
  });

  it('overview', async () => {
    const overview = checked('overview', await client.overview());
    expect(overview.app).toMatchObject({ id: APP_ID, mode: 'privacy', saltPeriod: 'month' });
    expect(overview.appInfo).toMatchObject({ name: 'Client test bot', approxGuilds: 2, eventWebhooksStatus: 2 });
    expect(overview.servers).toBe(1);
    expect(overview.sdkInstances.length).toBeGreaterThan(0);
    expect(overview.runs30d.length).toBeGreaterThan(0);
    expect(overview.uniqueUsersThisPeriod).toBe(4);
    expect(overview.checklist).toEqual({
      receivingEvents: true,
      appInfoReceived: true,
      webhookEventsEnabled: true,
      requiredPermissionsSet: true,
    });
  });

  it('commands', async () => {
    const { rows } = checked('commands', await client.commands({ range }));
    const byName = new Map(rows.map((row) => [row.command, row]));
    expect(byName.get('ticket')).toMatchObject({ runs: 5, registered: true, kinds: ['chat_input'], servers: 2 });
    expect(byName.get('ticket')?.errorRate).toBeCloseTo(0.6);
    expect(byName.get('ticket')?.uniqueUsersThisPeriod).toBe(4);
    expect(byName.get('ban')).toMatchObject({ runs: 1, registered: false, kinds: ['message_command'] });
    expect(byName.get('legacy-stats')).toMatchObject({ runs: 0, registered: true, lastUsed: null, errorRate: null });
  });

  it('command', async () => {
    const ticket = checked('command', await client.command('ticket', { range }));
    expect(ticket.totals).toMatchObject({ runs: 5, ok: 2, error: 1, timeout: 1, noResponse: 1 });
    expect(ticket.latencyHistogram?.reduce((a, b) => a + b, 0)).toBe(4);
    expect(ticket.subcommands).toEqual([{ key: 'open', value: 5 }]);
    expect(ticket.optionValues).toEqual([{ option: 'category', value: 'billing', runs: 1 }]);
    expect(ticket.topServers[0]).toEqual({ key: GUILD_A, value: 3, name: 'Test server', icon: null });
    expect(ticket.components).toEqual([{ key: 'ticket:close:*', kind: 'button', value: 1 }]);
    expect(ticket.modals).toEqual([{ customId: 'ticket:details', shown: 1, submitted: 1 }]);
    for (const list of [
      'kinds',
      'options',
      'memberTiers',
      'installs',
      'contexts',
      'channelTypes',
      'locales',
    ] as const) {
      expect(ticket[list].length, list).toBeGreaterThan(0);
    }

    const never = checked('command', await client.command('never-ran', { range }));
    expect(never.totals).toMatchObject({ runs: null, deferRate: null, firstSeen: null });
    expect(never.latencyHistogram).toBeNull();
  });

  it('series', async () => {
    const plain = checked(
      'series',
      await client.series({ metric: 'interactions', interval: 'hour', range, timezone: 'Europe/Berlin' }),
    );
    expect(plain.timezone).toBe('Europe/Berlin');
    expect(plain.points.length).toBeGreaterThan(0);
    expect(plain.points.every((p) => p.key === null)).toBe(true);
    expect(plain.points.reduce((sum, p) => sum + (p.value ?? 0), 0)).toBe(19);

    const split = checked(
      'series',
      await client.series({ metric: 'interactions', interval: 'day', range, groupBy: 'outcome', stat: 'p95' }),
    );
    expect(new Set(split.points.map((p) => p.key))).toEqual(new Set(['ok', 'error', 'timeout', 'no_response']));
    // Runs that got no response have no response time to take a percentile of.
    expect(split.points.find((p) => p.key === 'no_response')?.value).toBeNull();

    const custom = checked(
      'series',
      await client.series({ metric: 'custom', name: 'ticket_opened', interval: 'day', range }),
    );
    expect(custom.points.reduce((sum, p) => sum + (p.value ?? 0), 0)).toBe(2);
  });

  it('top', async () => {
    const commands = checked('top', await client.top({ metric: 'interactions', groupBy: 'command', range }));
    expect(commands.rows[0]).toEqual({ key: 'ping', value: 12, count: 12 });

    const servers = checked('top', await client.top({ metric: 'interactions', groupBy: 'guild', range }));
    expect(servers.rows[0]).toEqual({ key: GUILD_A, value: 17, count: 17, name: 'Test server', icon: null });

    const failing = checked(
      'top',
      await client.top({
        metric: 'interactions',
        groupBy: 'command',
        range,
        filters: [
          { field: 'guild', value: GUILD_A },
          { field: 'outcome', op: 'in', value: ['error', 'timeout', 'no_response'] },
        ],
      }),
    );
    expect(failing.rows).toEqual([{ key: 'ticket', value: 1, count: 1 }]);

    const routes = checked('top', await client.top({ metric: 'rest.calls', groupBy: 'route', range, stat: 'p95' }));
    expect(routes.rows.length).toBe(2);
  });

  it('heatmap', async () => {
    const heatmap = checked('heatmap', await client.heatmap({ range }));
    expect(heatmap.cells.length).toBeGreaterThan(0);
    expect(heatmap.cells.reduce((sum, cell) => sum + cell.value, 0)).toBe(19);
  });

  it('servers and server', async () => {
    const active = checked('servers', await client.servers());
    expect(active).toMatchObject({ total: 1, rows: [{ id: GUILD_A, name: 'Test server', runs: 17, leftAt: null }] });
    const all = checked('servers', await client.servers({ status: 'all', sort: 'name', order: 'asc', limit: 1 }));
    expect(all.total).toBe(2);
    expect(all.rows).toHaveLength(1);
    expect(checked('servers', await client.servers({ missingPermissions: true })).total).toBe(1);

    const server = checked('server', await client.server(GUILD_A));
    if (!server.found) throw new Error('the seeded server was not found');
    expect(server.profile).toMatchObject({ id: GUILD_A, memberCount: 42, botPermissions: '2048', leftAt: null });
    expect(server.events.map((e) => e.kind).sort()).toEqual(['available', 'join', 'unavailable']);
    expect(server.uniqueUsersThisPeriod).toBe(3);
    expect(server.missingPermissions).toBe('8192');

    expect(checked('server', await client.server('998877665544332211'))).toEqual({ found: false });
  });

  it('growth', async () => {
    const growth = checked('growth', await client.growth({ range }));
    expect(growth.daily.reduce((sum, d) => sum + (d.joins ?? 0), 0)).toBe(2);
    expect(growth.daily.reduce((sum, d) => sum + (d.leaves ?? 0), 0)).toBe(1);
    expect(growth.sizeAtInstall).toEqual([{ bucket: '11-100', servers: 2 }]);
    expect(growth.activation).toEqual({ joined: 2, activated: 2, rate: 1 });
    expect(growth.installs).toEqual({ active: 1, inactive: 0 });
    expect(growth.cohorts.length).toBeGreaterThan(0);
    expect(growth.lifetimes).toEqual([{ bucket: '<1d', servers: 1 }]);
    expect(growth.approximateGuilds.at(-1)?.value).toBe(2);
    expect(growth.serverCount).toMatchObject({ ours: 1, discord: 2, warn: true });
  });

  it('audience', async () => {
    const audience = checked('audience', await client.audience({ range }));
    expect(audience.daily.reduce((sum, d) => sum + d.newUsers, 0)).toBe(4);
    expect(audience.periods.at(-1)).toMatchObject({ users: 4, final: false });
    expect(Object.keys(audience.splits).sort()).toEqual(['context', 'install', 'locale', 'tier']);
    expect(audience.premiumShare).toBeGreaterThan(0);
  });

  it('reliability', async () => {
    const reliability = checked('reliability', await client.reliability({ range }));
    expect(reliability.totals).toMatchObject({ missedDeadlines: 2, noResponse: 1, errors: 1 });
    expect(reliability.errorsByCode).toHaveLength(2);
    expect(reliability.errorsByCode).toContainEqual({ key: '10062', value: 1 });
    expect(reliability.routes).toHaveLength(2);
    expect(reliability.routes.find((r) => r.failures)).toMatchObject({ method: 'POST', failures: 1, retries: 1 });
    expect(reliability.rateLimits).toEqual([
      { scope: 'user', route: '/channels/:id/messages', count: 1, maxRetryAfter: 1200 },
    ]);
    expect(reliability.invalidBudget).toEqual({ used: 3, limit: 10_000, share: 0.0003, shared429: 1 });
    expect(reliability.identify).toMatchObject({ remaining: 990, total: 1000, libVersion: '14.28.1' });
    expect(reliability.shards).toEqual([expect.objectContaining({ shard: 0, ping: 42, stale: true })]);
    expect(reliability.shardEvents.map((e) => e.state)).toEqual(['resumed', 'disconnected', 'ready']);
    expect(reliability.process).toEqual({ 'eventloop.p99_ms': 12, 'memory.rss_bytes': 180_000_000 });
    expect(reliability.sdkInstances[0]).toMatchObject({ queueDepth: 1, internalErrors: { listener: 1 } });
  });

  it('gauge', async () => {
    const whole = checked('gauge', await client.gauge({ name: 'shard.ping_ms', interval: 'hour', range }));
    expect(whole.points).toEqual([expect.objectContaining({ shard: null, value: 42, max: 42 })]);
    const perShard = checked(
      'gauge',
      await client.gauge({ name: 'shard.guilds', interval: 'minute', range: lastHour(), perShard: true }),
    );
    expect(perShard.points).toEqual([expect.objectContaining({ shard: 0, value: 2 })]);
  });

  it('bursts', async () => {
    const bursts = checked('bursts', await client.bursts({ range }));
    expect(bursts.rows).toEqual([{ minute: new Date(at(60)).toISOString(), runs: 12, median: 1 }]);
  });

  it('premium', async () => {
    const premium = checked('premium', await client.premium({ range }));
    expect(premium.changes).toEqual([{ sku: SKU, name: 'Pro', action: 'create', count: 1, testCount: 0 }]);
    expect(premium.activeEntitlements).toEqual([{ sku: SKU, name: 'Pro', active: 1 }]);
    expect(premium.subscriptions).toEqual([
      { sku: SKU, name: 'Pro', active: 1, ending: 0, inactive: 0, price: { amount: 4.99, currency: 'USD' } },
    ]);
    expect(premium.estimatedMonthlyRevenue).toEqual({ USD: 4.99 });
    expect(premium.pricesConfigured).toBe(true);
  });

  it('installs', async () => {
    const installs = checked('installs', await client.installs({ range }));
    expect(installs.daily.reduce((sum, d) => sum + d.userInstalls, 0)).toBe(1);
    expect(installs.scopes).toEqual([{ scope: 'applications.commands', installs: 1 }]);
    expect(installs.approximateUserInstalls.at(-1)?.value).toBe(5);
    expect(installs.webhookStatus).toBe(2);
  });

  it('events and eventProps', async () => {
    const events = checked('events', await client.events({ range }));
    expect(events.rows.map((row) => [row.name, row.count, row.users])).toEqual([
      ['ticket_opened', 2, 2],
      ['ticket_closed', 1, 1],
    ]);

    const keys = await client.eventProps({ name: 'ticket_opened', range });
    checked('eventProps', keys);
    expect(keys).toEqual({
      name: 'ticket_opened',
      keys: [
        { key: 'category', count: 2 },
        { key: 'priority', count: 1 },
      ],
    });
    const values = await client.eventProps({ name: 'ticket_opened', range, prop: 'priority' });
    checked('eventProps', values);
    // Values come back as text, whatever type the bot sent.
    expect(values).toEqual({ name: 'ticket_opened', prop: 'priority', values: [{ value: '2', count: 1 }] });
  });

  it('funnel', async () => {
    const funnel = checked(
      'funnel',
      await client.funnel({
        steps: [
          { type: 'event', name: 'ticket_opened' },
          { type: 'event', name: 'ticket_closed' },
        ],
        range,
        windowHours: 2,
      }),
    );
    expect(funnel.steps).toEqual([
      { label: 'ticket_opened', type: 'event', name: 'ticket_opened', users: 2, medianSeconds: null },
      { label: 'ticket_closed', type: 'event', name: 'ticket_closed', users: 1, medianSeconds: 50 * 60 },
    ]);
    expect(funnel.cohorts.reduce((sum, c) => sum + (c.users[0] ?? 0), 0)).toBe(2);
  });

  it('retention', async () => {
    const retention = checked(
      'retention',
      await client.retention({ start: { type: 'command', name: 'ticket' }, range, interval: 'day' }),
    );
    expect(retention).toMatchObject({ interval: 'day', start: '/ticket', return: 'any activity', periods: 14 });
    expect(retention.cohorts.reduce((sum, c) => sum + c.size, 0)).toBe(4);
    expect(retention.cohorts.every((c) => c.retained.length === 14)).toBe(true);
  });

  it('query() answers as the method of the same kind does', async () => {
    const spec = { kind: 'top', metric: 'interactions', groupBy: 'command', range } as const;
    expect(await client.query(spec)).toEqual(await client.top(spec));
    expect(checked('overview', await client.query({ kind: 'overview' })).servers).toBe(1);
  });

  it('meta', async () => {
    const meta = await client.meta();
    expect(MetaSchema.safeParse(meta).error?.issues).toBeUndefined();
    expect(meta).toMatchObject({
      appId: APP_ID,
      name: 'Client test bot',
      mode: 'privacy',
      auditKeyConfigured: false,
      webhookEventsConfigured: true,
    });
  });

  it('live', async () => {
    // The collector's side of each live stream: open until the client's connection is gone.
    let streams = 0;
    h.app.server.on('request', (req, res) => {
      if (req.url !== '/v1/live') return;
      streams++;
      res.once('close', () => streams--);
    });

    const updates: LiveUpdate[] = [];
    for await (const update of client.live()) {
      expect(streams).toBe(1);
      updates.push(update);
      if (updates.length === 2) break;
    }
    for (const update of updates) expect(LiveSchema.safeParse(update).error?.issues).toBeUndefined();
    expect(updates[0]).toMatchObject({ servers: 1, shards: [{ shard: 0, ping: 42, fresh: false }] });
    await expect.poll(() => streams, { timeout: 5_000 }).toBe(0);

    const controller = new AbortController();
    let seen = 0;
    for await (const _ of client.live({ signal: controller.signal })) {
      seen++;
      controller.abort();
    }
    expect(seen).toBe(1);
    await expect.poll(() => streams, { timeout: 5_000 }).toBe(0);
  });

  it('reports what the collector refuses as a ShardlensClientError', async () => {
    const refusal = async (call: Promise<unknown>) => {
      const error = await call.then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ShardlensClientError);
      return error as ShardlensClientError;
    };
    const unknownKey = createShardlensClient({ endpoint: url, apiKey: `slk_read_${'x'.repeat(43)}` });
    expect(await refusal(unknownKey.overview())).toMatchObject({ status: 401, code: 'unauthorized' });
    expect(await refusal(unknownKey.meta())).toMatchObject({ status: 401, code: 'unauthorized' });

    const threeDays = { from: new Date(now - 72 * HOUR).toISOString(), to: new Date(now).toISOString() };
    const tooLong = await refusal(client.series({ metric: 'interactions', interval: 'minute', range: threeDays }));
    expect(tooLong).toMatchObject({
      status: 400,
      code: 'invalid_query',
      message: 'minute series are limited to 2 days',
    });

    const backwards = await refusal(client.commands({ range: { from: range.to, to: range.from } }));
    expect(backwards).toMatchObject({ status: 400, code: 'invalid_request' });
    expect(backwards.message).toContain('range: from must be before to');

    const unkept = await refusal(client.top({ metric: 'rest.calls', groupBy: 'command', range }));
    expect(unkept).toMatchObject({ status: 400, code: 'invalid_query' });
    expect(unkept.message).toContain("rest.calls can't be grouped or filtered by command");

    // An ingest key is refused without a request; an unreachable collector is a network failure.
    const ingestKey = createShardlensClient({ endpoint: url, apiKey: INGEST_KEY });
    expect(await refusal(ingestKey.overview())).toMatchObject({ status: 0, code: 'invalid_options' });
    const nowhere = createShardlensClient({ endpoint: 'http://127.0.0.1:9', apiKey: READ_KEY, timeoutMs: 2_000 });
    expect(await refusal(nowhere.overview())).toMatchObject({ status: 0, code: 'network' });
  });
});

/** Minute series cover 2 days at most. */
function lastHour() {
  return { from: new Date(now - HOUR).toISOString(), to: new Date(now + MINUTE).toISOString() };
}
