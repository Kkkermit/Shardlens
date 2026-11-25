import { generateKeyPairSync, sign } from 'node:crypto';
import { uuidv7 } from '@shardlens/core';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedKey } from '../src/security/auth.js';
import { dimsKey, type RollupDoc, rollupId } from '../src/storage/mongodb/collections.js';
import { offsetPieces } from '../src/storage/mongodb/query/wall-clock.js';
import {
  APP_ID,
  envelope,
  type Harness,
  ingest,
  mongoStore,
  query,
  READ_KEY,
  sdkHasher,
  startHarness,
} from './harness.js';

/*
 * MongoDB's answers to the servers, audience, health and reports queries against PostgreSQL's: the same events go
 * through the HTTP API of a collector on each store, the jobs run, older history is written directly where ingest
 * can't reach (it accepts 34 days), and every spec must come back as the same JSON from both.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.now();
const ago = (ms: number) => NOW - ms;

const SKU = { pro: '1300000000000000001', plus: '1300000000000000002', guild: '1300000000000000003' };
const EMPTY_APP = '2234567890123456789';
const EMPTY_READ_KEY = `slk_read_${'E'.repeat(43)}`;
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const discordPublicKey = Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url').toString('hex');

/** Deterministic pseudo-random numbers, so a failure can be run again on the same data. */
function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
const rand = random(20261125);
const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;
const hourOf = (ms: number) => Math.floor(ms / HOUR) * HOUR;
const dayOf = (ms: number) => Math.floor(ms / DAY) * DAY;
const minuteOf = (ms: number) => Math.floor(ms / MINUTE) * MINUTE;

/** Every clock change of the zones with summer time in the last 400 days. */
const DST_ZONES = ['America/New_York', 'Europe/London', 'Australia/Lord_Howe'] as const;
const CHANGES = Object.fromEntries(
  DST_ZONES.map((zone) => [
    zone,
    offsetPieces(zone, ago(400 * DAY), NOW)
      .slice(1)
      .map((p) => p.start),
  ]),
) as Record<(typeof DST_ZONES)[number], number[]>;

type Event = Record<string, unknown>;
/** Events from one bot process. `user` fields hold a person's number until each collector's salt hashes it. */
interface Batch {
  instance: string;
  shards: number[];
  events: Event[];
}

const event = (ts: number, type: string, fields: Event): Event => ({ id: uuidv7(ts), ts, type, ...fields });
const shardOf = (id: string, count: number) => Number((BigInt(id) >> 22n) % BigInt(count));

interface Guild {
  id: string;
  name: string;
  members: number;
  locale: string;
  features: string[];
  permissions: string;
}

/** Servers that join after Shardlens is installed: IDs of 17, 18 and 19 digits, names that sort in awkward ways. */
const JOINED: Guild[] = [
  ['99999999999999999', 'Same', 42, 'en-GB', ['COMMUNITY'], '2048'],
  ['100000000000000000', 'same', 42, 'de', [], '8192'],
  ['1000000000000000000', 'SAME', 42, 'en-GB', ['COMMUNITY', 'PARTNERED'], '8'],
  ['312345678901234567', 'Zebra', 5, 'fr', [], '0'],
  ['81234567890123456', 'apple', 500, 'en-GB', ['COMMUNITY'], '10240'],
  ['1123456789012345678', 'Äpfel', 5000, 'de', ['PARTNERED'], '18446744073709551615'],
  ['1223456789012345678', 'éclair', 50000, 'fr', ['COMMUNITY'], '2147483648'],
  ['1323456789012345678', 'Éclair', 11, 'fr', [], '2048'],
  ['1423456789012345678', 'ΣΑΣ', 100, 'el', [], '2048'],
  ['1523456789012345678', 'σας', 101, 'el', [], '8192'],
  ['1623456789012345678', "O'Brien %_\\ test", 77, 'en-US', ['COMMUNITY'], '2048'],
  ['1723456789012345678', '_under', 1, 'en-US', [], '2048'],
  ['1823456789012345678', '10 Ten', 10000, 'en-US', ['COMMUNITY'], '2048'],
  ['1923456789012345678', 'Leaver quick', 20, 'en-GB', [], '2048'],
  ['2023456789012345678', 'Leaver week', 200, 'en-GB', [], '2048'],
  ['2123456789012345678', 'Leaver month', 2000, 'de', [], '2048'],
  ['2223456789012345678', 'Leaver long', 20000, 'de', [], '2048'],
  ['2323456789012345678', 'Never ran', 3, 'en-GB', [], '2048'],
].map(([id, name, members, locale, features, permissions]) => ({
  id: id as string,
  name: name as string,
  members: members as number,
  locale: locale as string,
  features: features as string[],
  permissions: permissions as string,
}));
const byName = (name: string) => JOINED.find((g) => g.name === name)!;
/** Joins either side of a clock change that ingest still accepts, so daily counts cross it. */
const DST_JOINS: { guild: Guild; ts: number }[] = DST_ZONES.flatMap((zone, z) =>
  CHANGES[zone]
    .filter((t) => t > ago(33 * DAY) && t < ago(2 * DAY))
    .flatMap((t) => [-3 * HOUR, -50 * MINUTE, 40 * MINUTE, 5 * HOUR].map((offset) => t + offset))
    .map((ts, i) => ({
      guild: {
        id: `${2600000000000000000n + BigInt(z * 100 + i)}`,
        name: `Clock change ${zone} ${i}`,
        members: 30 + i,
        locale: 'en-US',
        features: [],
        permissions: '2048',
      },
      ts,
    })),
);

function info(g: Guild, joinedAt: number, overrides: Event = {}): Event {
  return {
    guild: g.id,
    name: g.name,
    icon: g.name.length % 2 ? `icon${g.id.slice(-4)}` : null,
    memberCount: g.members,
    large: g.members > 250,
    preferredLocale: g.locale,
    features: g.features,
    premiumTier: g.members % 4,
    boosts: g.members % 7,
    verificationLevel: 1,
    nsfwLevel: 0,
    mfaLevel: g.members % 2,
    createdAt: 1_500_000_000_000 + Number(BigInt(g.id) % 1_000_000n),
    joinedAt,
    shard: shardOf(g.id, 2),
    channelCounts: { '0': g.members % 9, '2': 1 },
    roleCount: 3,
    emojiCount: 2,
    stickerCount: 0,
    botPermissions: g.permissions,
    ...overrides,
  };
}

/** Everything the bot sends, in the order it sends it. */
function script(): Batch[] {
  const main: Event[] = [];
  const active = new Set<string>();
  const baseline = [0, 0, 1].map((shard, i) => ({
    id: `${(BigInt(ago(400 * DAY) - 1_420_070_400_000) << 22n) + BigInt(i)}`,
    shard,
  }));
  // Snowflakes whose shard of two is the one wanted.
  for (const b of baseline) {
    let id = BigInt(b.id);
    while (shardOf(id.toString(), 2) !== b.shard) id += 1n << 22n;
    b.id = id.toString();
  }
  const baseGuilds = baseline.map((b, i) => ({
    id: b.id,
    name: ['Old guard', 'old Guard 2', 'Ancient'][i]!,
    members: [900, 15, 120][i]!,
    locale: 'en-GB',
    features: ['COMMUNITY'],
    permissions: '2048',
  }));

  const snapshot = (ts: number, count: number, shards: number[], drop?: string, extra?: string) => {
    for (const shard of shards) {
      const guilds = [...active].filter((id) => shardOf(id, count) === shard && id !== drop);
      if (extra && shardOf(extra, count) === shard) guilds.push(extra);
      main.push(event(ts, 'guild_snapshot', { shards: [shard], shardCount: count, guilds }));
    }
    if (drop) active.delete(drop);
    if (extra) active.add(extra);
  };
  const join = (ts: number, g: Guild) => {
    main.push(event(ts, 'guild_join', { info: info(g, ts), detectedAtStartup: false }));
    active.add(g.id);
  };
  const leave = (ts: number, g: Guild) => {
    main.push(event(ts, 'guild_leave', { guild: g.id, detectedAtStartup: false }));
    active.delete(g.id);
  };

  // Installed 33.5 days ago: the first complete snapshot is a baseline, then the profiles say when the bot joined.
  for (const b of baseGuilds) active.add(b.id);
  const installed = ago(33.5 * DAY);
  main.push(
    ...[0, 1].map((shard) =>
      event(installed, 'guild_snapshot', {
        shards: [shard],
        shardCount: 2,
        guilds: baseGuilds.filter((g) => shardOf(g.id, 2) === shard).map((g) => g.id),
      }),
    ),
  );
  for (const [i, b] of baseGuilds.entries()) {
    main.push(event(installed + MINUTE, 'guild_update', { info: info(b, ago((500 + i * 90) * DAY)) }));
  }

  // Joins, spread out, with profiles refreshed later and the odd outage.
  for (const [i, g] of JOINED.entries()) join(ago((33 - i * 1.7) * DAY + 13 * MINUTE), g);
  for (const { guild, ts } of DST_JOINS) join(ts, guild);
  const lifetimes: [string, number, number][] = [
    ['Leaver quick', 10 * DAY, 3 * HOUR],
    ['Leaver week', 20 * DAY, 3 * DAY],
    ['Leaver month', 30 * DAY, 15 * DAY],
    ['Leaver long', 33 * DAY, 32 * DAY + 5 * HOUR],
  ];
  // Rejoin times put each leaver's join at its own time: their joins above are replaced by these.
  for (const [name, joinedAgo] of lifetimes) {
    const g = byName(name);
    main.splice(
      main.findIndex((e) => e.type === 'guild_join' && (e.info as Event).guild === g.id),
      1,
      event(ago(joinedAgo), 'guild_join', { info: info(g, ago(joinedAgo)), detectedAtStartup: false }),
    );
  }
  main.sort((a, b) => (a.ts as number) - (b.ts as number));
  for (const [name, joinedAgo, lived] of lifetimes) {
    const g = byName(name);
    main.push(event(ago(joinedAgo) + lived, 'guild_leave', { guild: g.id, detectedAtStartup: false }));
  }
  // Zebra leaves and comes back; Old guard (a baseline server) leaves for good.
  leave(ago(25 * DAY), byName('Zebra'));
  join(ago(24 * DAY), byName('Zebra'));
  main.push(event(ago(9 * DAY), 'guild_leave', { guild: baseGuilds[0]!.id, detectedAtStartup: false }));
  main.push(
    event(ago(5 * DAY), 'guild_availability', { guild: byName('apple').id, available: false, shard: 0 }),
    event(ago(5 * DAY) + 20 * MINUTE, 'guild_availability', { guild: byName('apple').id, available: true, shard: 0 }),
    event(ago(6 * DAY), 'guild_update', {
      info: info(byName('apple'), ago(31.3 * DAY), { memberCount: 640, botPermissions: '8' }),
    }),
  );
  main.sort((a, b) => (a.ts as number) - (b.ts as number));
  // Replay the lifecycle to know who is in at each snapshot.
  active.clear();
  for (const b of baseGuilds) active.add(b.id);
  const lifecycle = main.filter((e) => e.type === 'guild_join' || e.type === 'guild_leave');
  const replay = (until: number) => {
    for (const e of lifecycle) {
      if ((e.ts as number) >= until || e.replayed) continue;
      e.replayed = true;
      if (e.type === 'guild_join') active.add((e.info as Event).guild as string);
      else active.delete(e.guild as string);
    }
  };
  // A restart 20 days ago: shard 0 finds one server gone and one new while it was offline.
  const restart = ago(20 * DAY);
  replay(restart);
  const goneOnRestart = [...active].find((id) => shardOf(id, 2) === 0 && JOINED.some((g) => g.id === id))!;
  const foundOnRestart = '2423456789012345678';
  snapshot(restart, 2, [0], goneOnRestart, foundOnRestart);
  // Resharded to three, an hour ago: every shard reports, one server is gone, another new.
  const reshard = ago(HOUR);
  replay(reshard);
  const goneOnReshard = [...active].find((id) => id === byName('Never ran').id)!;
  const foundOnReshard = '2523456789012345678';
  snapshot(reshard, 3, [0, 1, 2], goneOnReshard, foundOnReshard);
  const found = { id: foundOnReshard, name: 'Found later', members: 64, locale: 'ja', features: [], permissions: '0' };
  main.push(event(reshard + MINUTE, 'guild_update', { info: info(found, ago(2 * HOUR), { shard: 2 }) }));
  for (const e of lifecycle) delete e.replayed;

  // Runs over 34 days, in the servers that are in at the time, and in DMs.
  const commands = ['ticket', 'ping', 'ban', 'settings', 'stats'];
  const locales = ['en-GB', 'en-US', 'de', 'fr', 'pt-BR', 'ja'];
  const outcomes = ['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'error', 'timeout', 'no_response'];
  const runGuilds = JOINED.filter((g) => !['Never ran', 'Leaver quick', 'Same'].includes(g.name)).map((g) => g.id);
  for (let i = 0; i < 900; i++) {
    const ts = ago(33.8 * DAY) + Math.floor(rand() * 33.7 * DAY);
    const kind = pick(['chat_input', 'chat_input', 'chat_input', 'user_context', 'button', 'modal_submit']);
    const outcome = pick(outcomes);
    const dm = rand() < 0.15;
    main.push(
      event(ts, 'interaction', {
        kind,
        command: kind === 'button' || kind === 'modal_submit' ? undefined : pick(commands),
        sub: rand() < 0.3 ? 'open' : undefined,
        options: [],
        customId: kind === 'button' ? 'ticket:close' : kind === 'modal_submit' ? 'settings:modal' : undefined,
        context: dm ? 1 : pick([0, 0, 0, 2]),
        install: pick(['guild', 'guild', 'user', 'both']),
        guild: dm ? undefined : pick(runGuilds),
        locale: pick(locales),
        memberTier: dm ? 'dm' : pick(['admin', 'manager', 'member', 'member']),
        user: Math.floor(rand() * 40),
        premium: rand() < 0.2,
        outcome,
        errorCode: outcome === 'error' && rand() < 0.5 ? pick([10062, 50013]) : undefined,
        errorClass: outcome === 'error' ? pick(['TypeError', 'DiscordAPIError']) : undefined,
        ackMs: outcome === 'no_response' ? undefined : Math.floor(20 + rand() * (rand() < 0.1 ? 6000 : 900)),
        deferred: rand() < 0.3,
        weight: pick([1, 1, 1, 2, 0.5]),
      }),
    );
  }
  // Runs in a server whose last command is then over 30 days old; a burst of runs in one minute; prefix commands.
  main.push(event(ago(31.5 * DAY), 'interaction', runIn(byName('Same').id, 5)));
  const burst = Math.floor(ago(3 * DAY) / MINUTE) * MINUTE;
  for (let i = 0; i < 30; i++) main.push(event(burst + i * 1000, 'interaction', runIn(byName('apple').id, i % 7)));
  for (let i = 0; i < 12; i++) {
    main.push(
      event(ago(i * 2.5 * DAY + 7 * MINUTE), 'message_command', {
        command: 'ban',
        options: [],
        guild: byName('apple').id,
        memberTier: 'admin',
        user: i,
        outcome: i % 5 ? 'ok' : 'error',
        errorClass: i % 5 ? undefined : 'Error',
        handlerMs: 12,
      }),
    );
  }

  // REST every six hours, with failures, retries and latency; rate limits; gateway state changes.
  const latency = (peak: number) =>
    Array.from({ length: 40 }, (_, b) => (Math.abs(b - peak) < 3 ? 3 - Math.abs(b - peak) : 0));
  for (let t = ago(33 * DAY); t < ago(30 * MINUTE); t += 6 * HOUR) {
    main.push(
      event(t, 'rest_window', {
        windowMs: 60_000,
        rows: [
          {
            method: 'POST',
            route: '/interactions/:id/:token/callback',
            status: 204,
            count: 20,
            retries: 0,
            latency: latency(14),
          },
          { method: 'POST', route: '/channels/:id/messages', status: 200, count: 6, retries: 1, latency: latency(18) },
          { method: 'POST', route: '/channels/:id/messages', status: 429, count: 1, retries: 2, latency: latency(25) },
          { method: 'GET', route: '/guilds/:id', status: 404, count: 2, retries: 0, latency: latency(10) },
          {
            method: 'PATCH',
            route: '/webhooks/:id/:token/messages/@original',
            status: 500,
            count: 1,
            retries: 1,
            latency: latency(30),
          },
        ],
        invalid: { count401: 0, count403: 1, count429: 1, shared429: 0 },
      }),
    );
  }
  main.push(
    event(ago(3 * MINUTE), 'rest_window', {
      windowMs: 60_000,
      rows: [{ method: 'GET', route: '/users/@me', status: 401, count: 3, retries: 0, latency: latency(8) }],
      invalid: { count401: 3, count403: 2, count429: 4, shared429: 1 },
    }),
  );
  for (let i = 0; i < 9; i++) {
    main.push(
      event(ago(i * 3.3 * DAY + 11 * MINUTE), 'rate_limit', {
        scope: ['user', 'shared', 'global'][i % 3],
        global: i % 3 === 2,
        route: ['/channels/:id/messages', '/guilds/:id/members'][i % 2],
        method: 'POST',
        limit: 5,
        retryAfter: 500 + i * 250,
        sublimitTimeout: 0,
      }),
    );
  }
  for (let i = 0; i < 14; i++) {
    main.push(
      event(ago(i * 2.2 * DAY + 3 * MINUTE), 'shard_state', {
        shard: i % 3,
        state: ['ready', 'disconnected', 'resumed', 'reconnecting'][i % 4],
        closeCode: i % 4 === 1 ? 1006 : undefined,
        replayed: i % 4 === 2 ? i * 3 : undefined,
      }),
    );
  }

  // What the bot reports of its application, now and then: its approximate counts become gauges.
  for (let d = 28; d >= 0; d -= 3) {
    main.push(
      event(ago(d * DAY + 2 * HOUR), 'app_info', {
        name: 'Parity bot',
        approximateGuildCount: 14 + (d % 5),
        approximateUserInstallCount: 30 - d,
        approximateUserAuthorizationCount: 31 - d,
        dashboardUserIds: [],
        eventWebhooksStatus: 2,
        skus: [
          { id: SKU.pro, name: 'Pro', type: 5 },
          { id: SKU.plus, name: 'Plus', type: 5 },
        ],
        sessionStartRemaining: 990 - d,
        sessionStartTotal: 1000,
        nodeVersion: 'v24.11.0',
        libVersion: '14.28.1',
      }),
    );
  }

  // Entitlements: bought, renewed, refunded and tested, by people and by servers; subscriptions over time.
  const entitlement = (ts: number, fields: Event) =>
    main.push(event(ts, 'entitlement', { entitlementType: 8, owner: 'user', startsAt: null, endsAt: null, ...fields }));
  for (let u = 0; u < 8; u++) entitlement(ago((30 - u * 3) * DAY), { action: 'create', sku: SKU.pro, user: u });
  entitlement(ago(5 * DAY), { action: 'delete', sku: SKU.pro, user: 1 });
  entitlement(ago(4 * DAY), { action: 'update', sku: SKU.pro, user: 2, endsAt: ago(DAY) });
  entitlement(ago(4 * DAY), { action: 'update', sku: SKU.pro, user: 3, endsAt: ago(-20 * DAY) });
  entitlement(ago(7 * DAY), { action: 'create', sku: SKU.plus, user: 4, entitlementType: 4 });
  entitlement(ago(6 * DAY), { action: 'create', sku: SKU.plus, user: 5, entitlementType: 4 });
  entitlement(ago(12 * DAY), { action: 'create', sku: SKU.guild, owner: 'guild', guild: byName('apple').id });
  entitlement(ago(2 * DAY), { action: 'create', sku: SKU.guild, owner: 'guild', guild: byName('Zebra').id });
  const subscription = (ts: number, user: number, skus: string[], status: number) =>
    main.push(
      event(ts, 'subscription', {
        action: 'update',
        status,
        skus,
        user,
        periodStart: ts,
        periodEnd: ts + 30 * DAY,
      }),
    );
  subscription(ago(25 * DAY), 0, [SKU.pro], 0);
  subscription(ago(3 * DAY), 0, [SKU.pro, SKU.plus], 1);
  subscription(ago(20 * DAY), 1, [SKU.plus], 2);
  subscription(ago(15 * DAY), 2, [SKU.pro], 0);
  subscription(ago(2 * DAY), 2, [], 0);
  subscription(ago(9 * DAY), 3, [SKU.pro, SKU.pro], 0);
  subscription(ago(8 * DAY), 4, [SKU.plus], 0);
  subscription(ago(7 * DAY), 5, [SKU.guild], 1);

  main.sort((a, b) => (a.ts as number) - (b.ts as number));
  const batches: Batch[] = chunk(main, 300).map((events) => ({ instance: 'proc:a', shards: [0, 1], events }));
  batches.push(...gaugeBatches());
  return batches;
}

function runIn(guild: string, user: number): Event {
  return {
    kind: 'chat_input',
    command: 'ping',
    options: [],
    context: 0,
    install: 'guild',
    guild,
    locale: 'en-GB',
    memberTier: 'member',
    user,
    premium: false,
    outcome: 'ok',
    ackMs: 80,
  };
}

/**
 * Gauges from three processes: `proc:a` holds shards 0 and 1, `proc:b` shard 2 until it is restarted as `proc:c` two
 * hours ago, both reporting within the same minute. Every 20 minutes for 28 days, every minute for the last 3 hours.
 */
function gaugeBatches(): Batch[] {
  const times: number[] = [];
  for (let t = minuteOf(ago(28 * DAY)); t < ago(3 * HOUR); t += 20 * MINUTE) times.push(t);
  for (let t = minuteOf(ago(3 * HOUR)); t < ago(MINUTE); t += MINUTE) times.push(t);
  const restart = minuteOf(ago(2 * HOUR));
  const out: Batch[] = [];
  for (const [instance, shards, live] of [
    ['proc:a', [0, 1], () => true],
    ['proc:b', [2], (t: number) => t < restart + 30_000],
    ['proc:c', [2], (t: number) => t >= restart],
  ] as const) {
    const events: Event[] = [];
    for (const [i, t0] of times.entries()) {
      if (!live(t0)) continue;
      const t = t0 + (instance === 'proc:c' ? 15_000 : 5_000);
      const k = i % 17;
      events.push(
        event(t, 'gauge_window', {
          gauges: [
            ...shards.map((shard) => ({ name: 'shard.ping_ms', shard, value: 40 + ((k + shard * 5) % 13) })),
            ...shards.map((shard) => ({ name: 'shard.guilds', shard, value: 5 + shard + (k % 3) })),
            { name: 'memory.rss_bytes', value: (150 + k + shards[0]! * 40) * 1_000_000 },
            { name: 'eventloop.p99_ms', value: 8 + k / 4 + shards[0]! },
            { name: 'cache.users', value: 1_000 + k * 10 },
          ],
        }),
      );
      if (i % 36 === 0 || t0 >= ago(10 * MINUTE)) {
        events.push(
          event(t + 1, 'sdk_health', {
            queueDepth: k,
            dropped: { queue_full: k % 2 },
            failedFlushes: k % 3,
            internalErrors: { listener: k % 4 },
          }),
        );
      }
    }
    for (const events300 of chunk(events, 300)) out.push({ instance, shards: [...shards], events: events300 });
  }
  return out;
}

function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Discord's webhook deliveries: user and server installs, removals, an entitlement. Around both DST changes too. */
function webhookDeliveries(): object[] {
  const delivery = (ts: number, type: string, data: object) => ({
    version: 1,
    application_id: APP_ID,
    type: 1,
    event: { type, timestamp: new Date(ts).toISOString(), data },
  });
  const user = (n: number) => ({ id: String(500000000000000000n + BigInt(n)), username: `u${n}` });
  // The entitlement first: deliveries are stored in order, and the seed waits for the installs.
  const out: object[] = [
    delivery(ago(4 * DAY), 'ENTITLEMENT_CREATE', {
      id: '1400000000000000001',
      sku_id: SKU.plus,
      user_id: user(3).id,
      type: 8,
      starts_at: null,
      ends_at: null,
    }),
  ];
  // Either side of each clock change still kept, and late in the UTC day, past midnight east of UTC.
  const times = [
    ...DST_ZONES.flatMap((zone) =>
      CHANGES[zone].flatMap((t) => [t - 90 * MINUTE, t - 20 * MINUTE, t + 20 * MINUTE, t + 22 * HOUR]),
    ),
    dayOf(ago(6 * DAY)) + 18 * HOUR + 45 * MINUTE,
    dayOf(ago(7 * DAY)) + 13 * HOUR + 15 * MINUTE,
  ].filter((t) => t > ago(32 * DAY) && t < ago(HOUR));
  times.forEach((t, i) => {
    out.push(
      delivery(t, 'APPLICATION_AUTHORIZED', { integration_type: 1, scopes: ['applications.commands'], user: user(i) }),
    );
  });
  for (let i = 0; i < 10; i++) {
    const t = ago(i * 2.7 * DAY + 37 * MINUTE);
    if (i % 3 === 0) {
      out.push(
        delivery(t, 'APPLICATION_AUTHORIZED', {
          integration_type: 0,
          scopes: ['bot', 'applications.commands'],
          user: user(20 + i),
          guild: { id: byName('apple').id },
        }),
      );
    } else if (i % 3 === 1) {
      out.push(delivery(t, 'APPLICATION_DEAUTHORIZED', { user: user(i) }));
    } else {
      out.push(
        delivery(t, 'APPLICATION_AUTHORIZED', {
          integration_type: 1,
          scopes: ['applications.commands', 'identify'],
          user: user(40 + i),
        }),
      );
    }
  }
  return out;
}

let pg: Harness;
let mg: Harness;

async function seed(h: Harness, batches: Batch[], deliveries: object[]) {
  const { hasher, period } = await sdkHasher(h.app);
  const hashes = new Map<number, string>();
  const hash = async (n: number) => {
    let hashed = hashes.get(n);
    if (!hashed) {
      hashed = (await hasher.hash(String(300000000000000000n + BigInt(n)), period)) as string;
      hashes.set(n, hashed);
    }
    return hashed;
  };
  for (const batch of batches) {
    const events = await Promise.all(
      batch.events.map(async (e) => (typeof e.user === 'number' ? { ...e, user: await hash(e.user) } : e)),
    );
    const res = await ingest(h.app, envelope(events, { source: { shards: batch.shards, instance: batch.instance } }));
    expect(res.statusCode, res.body).toBe(202);
    expect(res.json().rejected, res.body).toEqual([]);
  }
  for (const body of deliveries) {
    const raw = Buffer.from(JSON.stringify(body));
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/discord/events',
      headers: {
        'content-type': 'application/json',
        'x-signature-ed25519': sign(null, Buffer.concat([Buffer.from(ts), raw]), privateKey).toString('hex'),
        'x-signature-timestamp': ts,
      },
      payload: raw,
    });
    expect(res.statusCode).toBe(204);
  }
  // Deliveries are stored after the answer: wait until all of them are.
  const range = { from: new Date(ago(33 * DAY)).toISOString(), to: new Date(NOW + HOUR).toISOString() };
  for (let tries = 0; ; tries++) {
    const installs = (await query(h.app, { kind: 'installs', range })).json() as {
      daily: { userInstalls: number; userRemovals: number; serverInstalls: number }[];
    };
    const stored = installs.daily.reduce((a, d) => a + d.userInstalls + d.userRemovals + d.serverInstalls, 0);
    if (stored === deliveries.length - 1) break;
    if (tries > 50) throw new Error(`only ${stored} webhook deliveries stored`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await h.store.settings.set(APP_ID, 'required_permissions', '10240');
  await h.store.settings.set(APP_ID, 'sku_prices', {
    [SKU.pro]: { amount: 4.5, currency: 'USD' },
    [SKU.plus]: { amount: 2.25, currency: 'USD' },
    [SKU.guild]: { amount: 9, currency: 'EUR' },
  });
  await h.store.settings.set(APP_ID, 'badges', ['servers', 'users-monthly', 'commands-daily']);
  await h.store.jobs.backfillRollups(new Date(ago(35 * DAY)), new Date(NOW + MINUTE));
  await h.store.jobs.runUniques();
  await h.store.apps.register(EMPTY_APP);
  await seedKey(h.store, EMPTY_APP, EMPTY_READ_KEY, 'empty read');
}

/**
 * History older than ingest accepts, written as the jobs would have left it, the same on both stores: rollups of
 * 35 days to 400 days ago, the unique counts of salt periods long gone, servers that joined months ago.
 */
async function writeHistory() {
  const rollup = async (
    grain: 'hour' | 'day',
    metric: string,
    bucket: number,
    dims: RollupDoc['dims'],
    figures: { count: number; sum?: number; max?: number; hist?: number[] },
  ) => {
    const table = grain === 'hour' ? 'rollup_1h' : 'rollup_1d';
    await pg.db.query(
      `INSERT INTO ${table} (app_id, bucket, metric, dims_hash, dims, count, sum, max, hist)
       VALUES ($1, $2, $3, sha256(convert_to($4::text, 'UTF8')), $4::jsonb, $5, $6, $7, $8)`,
      [
        APP_ID,
        new Date(bucket),
        metric,
        JSON.stringify(dims),
        figures.count,
        figures.sum ?? 0,
        figures.max ?? null,
        figures.hist ?? null,
      ],
    );
    const key = dimsKey(dims);
    const doc: RollupDoc = {
      _id: rollupId(APP_ID, metric, new Date(bucket), key),
      appId: APP_ID,
      metric,
      bucket: new Date(bucket),
      dims,
      dimsKey: key,
      count: figures.count,
      sum: figures.sum ?? 0,
    };
    if (figures.max !== undefined) doc.max = figures.max;
    if (figures.hist) doc.hist = figures.hist;
    await (grain === 'hour' ? mg.mongo.c.rollup1h : mg.mongo.c.rollup1d).insertOne(doc);
  };
  // Joins and leaves an hour at a time, around the clock changes older than ingest accepts, and in between.
  const older = (t: number) => t < ago(36 * DAY);
  const around = DST_ZONES.flatMap((zone) => CHANGES[zone].filter((t) => older(t) && t > ago(390 * DAY)));
  const hours = [
    ...new Set([
      ...around.filter((t) => t > ago(394 * DAY)).flatMap((t) => [-2, -1, 0, 1].map((h) => hourOf(t) + h * HOUR)),
      ...[40, 47.5, 55, 61, 70, 77, 85, 99].map((d) => hourOf(ago(d * DAY))),
    ]),
  ].sort((a, b) => a - b);
  for (const [i, bucket] of hours.entries()) {
    await rollup('hour', 'guild.joins', bucket, { detected: i % 3 === 0 }, { count: 1 + (i % 4) });
    if (i % 2) await rollup('hour', 'guild.leaves', bucket, { detected: false }, { count: 1 });
    await rollup('hour', 'interactions', bucket, interactionDims(i), { count: 2 + i, sum: 300 * i, hist: hist(i) });
    await rollup(
      'hour',
      'rest.calls',
      bucket,
      { method: 'GET', route: '/gateway/bot', status: i % 2 ? 200 : 503 },
      {
        count: 3,
        sum: i % 2,
        hist: hist(i + 5),
      },
    );
  }
  // Days, all that is kept after 13 months: on clock changes, and up to 399 days back.
  const days = new Set([
    ...around.map(dayOf),
    ...[120, 200, 241, 300, 390, 397, 398.5].map((d) => dayOf(ago(d * DAY))),
  ]);
  for (const [i, day] of [...days].sort((a, b) => a - b).entries()) {
    await rollup('day', 'guild.joins', day, { detected: false }, { count: 2 + i });
    if (i % 2) await rollup('day', 'guild.leaves', day, { detected: true }, { count: 1 + i });
    await rollup('day', 'interactions', day, interactionDims(i + 3), { count: 5 + i, sum: 100, hist: hist(i) });
  }

  // A server in for four months that left ten days ago, and one that joined two months ago and runs commands.
  const guild = async (id: string, name: string, joinedAt: number, leftAt: number | null, size: number) => {
    await pg.db.query(
      `INSERT INTO guilds (app_id, guild_id, name, member_count, size_at_join, features, joined_at, left_at,
                           first_command_at, last_command_at, preferred_locale)
       VALUES ($1, $2, $3, $4, $4, '{}', $5, $6, $7, $8, 'en-GB')`,
      [
        APP_ID,
        id,
        name,
        size,
        new Date(joinedAt),
        leftAt && new Date(leftAt),
        new Date(joinedAt + HOUR),
        new Date(ago(40 * DAY)),
      ],
    );
    await mg.mongo.c.guilds.insertOne({
      _id: { appId: APP_ID, guildId: id },
      name,
      memberCount: size,
      sizeAtJoin: size,
      features: [],
      joinedAt: new Date(joinedAt),
      ...(leftAt !== null && { leftAt: new Date(leftAt) }),
      firstCommandAt: new Date(joinedAt + HOUR),
      lastCommandAt: new Date(ago(40 * DAY)),
      preferredLocale: 'en-GB',
      detectedAtStartup: false,
      baseline: false,
      updatedAt: new Date(),
    });
  };
  await guild('3023456789012345678', 'Four months', ago(120 * DAY), ago(10 * DAY), 12);
  await guild('3123456789012345678', 'Two months', ago(60 * DAY), null, 2_500);
  for (const d of [59, 52, 45, 41]) {
    await rollup('day', 'interactions.by_guild', dayOf(ago(d * DAY)), byGuildDims('3123456789012345678'), { count: 3 });
  }

  // Unique counts of salt periods destroyed long ago: their days, the weeks wholly inside them, the whole periods.
  const unique = async (grain: 'day' | 'week' | 'month', startDay: string, users: number, newUsers: number) => {
    await pg.db.query(
      `INSERT INTO unique_counts (app_id, grain, start_day, scope, scope_key, users, new_users, final)
       VALUES ($1, $2, $3, 'global', '*', $4, $5, true)`,
      [APP_ID, grain, startDay, users, newUsers],
    );
    await mg.mongo.c.uniqueCounts.insertOne({
      _id: { appId: APP_ID, grain, startDay, scope: 'global', scopeKey: '*' },
      users,
      newUsers,
      final: true,
    });
  };
  for (let d = 40; d <= 100; d += 3) await unique('day', isoDay(ago(d * DAY)), 10 + (d % 7), d % 5);
  const monday = dayOf(ago(40 * DAY)) - ((new Date(dayOf(ago(40 * DAY))).getUTCDay() + 6) % 7) * DAY;
  for (const k of [0, 1, 3, 5, 6, 8]) await unique('week', isoDay(monday - k * 7 * DAY), 30 + k, 0);
  // Whole periods of earlier months: the current salt's month and the one before it are the job's.
  const today = new Date(NOW);
  for (let k = 2; k <= 5; k++) {
    await unique('month', isoDay(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - k, 1)), 60 + k * 7, 0);
  }
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const hist = (i: number) =>
  Array.from({ length: 40 }, (_, b) => (b === 10 + (i % 20) ? 2 + (i % 3) : b === 25 ? 1 : 0));
const interactionDims = (i: number): RollupDoc['dims'] => ({
  kind: i % 4 === 3 ? 9 : 1,
  command: ['ticket', 'ping'][i % 2]!,
  sub: null,
  outcome: i % 5 === 0 ? 1 : 0,
  context: i % 3,
  install: i % 4 === 3 ? null : i % 2,
  locale: i % 4 === 3 ? '' : ['es-ES', 'en-GB', 'ko'][i % 3]!,
  tier: i % 4 === 3 ? 0 : 2,
});
const byGuildDims = (guild: string): RollupDoc['dims'] => ({ kind: 1, command: 'ping', outcome: 0, guild });

beforeAll(async () => {
  [pg, mg] = await Promise.all([
    startHarness({ discordPublicKey }),
    startHarness({ discordPublicKey, store: mongoStore }),
  ]);
  const batches = script();
  const deliveries = webhookDeliveries();
  await Promise.all([seed(pg, batches, deliveries), seed(mg, batches, deliveries)]);
  await writeHistory();
});

afterAll(async () => {
  await Promise.all([pg?.close(), mg?.close()]);
});

const range = (fromAgo: number, toAgo = -MINUTE) => ({
  from: new Date(ago(fromAgo)).toISOString(),
  to: new Date(ago(toAgo)).toISOString(),
});
const RANGES = {
  hour: range(HOUR),
  day: range(DAY),
  week: range(7 * DAY + 17 * MINUTE),
  month: range(30 * DAY),
  ingested: range(34 * DAY),
  past: range(20 * DAY, 10 * DAY),
  quarter: range(100 * DAY),
  long: range(399 * DAY),
  // Around each zone's last clock change.
  ...Object.fromEntries(
    DST_ZONES.map((zone) => {
      const t = CHANGES[zone].at(-1)!;
      return [
        zone,
        { from: new Date(dayOf(t) - 2 * DAY).toISOString(), to: new Date(dayOf(t) + 3 * DAY).toISOString() },
      ];
    }),
  ),
} as Record<string, { from: string; to: string }>;
const ZONES = ['UTC', 'America/New_York', 'Europe/London', 'Australia/Lord_Howe', 'Asia/Kolkata'];

type Answer = Record<string, unknown>;

/** Where PostgreSQL leaves an order open (no ORDER BY, or ties), both answers are put in one order first. */
function settle(kind: string, answer: Answer): Answer {
  const a = structuredClone(answer);
  const byKey = <T>(list: T[], key: (r: T) => string) =>
    list.sort((x, y) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0));
  const byCount = <T>(list: T[], count: (r: T) => number, key: (r: T) => string) =>
    list.sort((x, y) => count(y) - count(x) || (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0));
  type Row = Record<string, unknown>;
  const rows = (v: unknown) => v as Row[];
  if (kind === 'growth') {
    byKey(rows(a.sizeAtInstall), (r) => String(r.bucket));
    byKey(rows(a.lifetimes), (r) => String(r.bucket));
  }
  if (kind === 'premium') {
    byKey(rows(a.activeEntitlements), (r) => String(r.sku));
    byKey(rows(a.subscriptions), (r) => String(r.sku));
  }
  if (kind === 'audience') {
    for (const list of Object.values(a.splits as Record<string, Row[]>))
      byCount(
        list,
        (r) => Number(r.value),
        (r) => String(r.key),
      );
  }
  if (kind === 'reliability') {
    byCount(
      rows(a.errorsByCode),
      (r) => Number(r.value),
      (r) => String(r.key),
    );
    byCount(
      rows(a.routes),
      (r) => Number(r.calls),
      (r) => `${r.method} ${r.route}`,
    );
    byCount(
      rows(a.rateLimits),
      (r) => Number(r.count),
      (r) => `${r.scope} ${r.route}`,
    );
  }
  if (kind === 'bursts')
    byCount(
      rows(a.rows),
      (r) => Number(r.runs),
      (r) => String(r.minute),
    );
  if (kind === 'installs')
    byCount(
      rows(a.scopes),
      (r) => Number(r.installs),
      (r) => String(r.scope),
    );
  if (kind === 'server' && a.found) (a.profile as Row).updatedAt = 'written at ingest';
  return a;
}

/** The paths at which two answers differ, for a readable failure. */
function differences(a: unknown, b: unknown, path = '$'): string[] {
  if (Object.is(a, b)) return [];
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return [`${path}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`];
  }
  if (Array.isArray(a) !== Array.isArray(b)) return [`${path}: array ≠ object`];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].flatMap((k) => differences((a as Answer)[k], (b as Answer)[k], `${path}.${k}`));
}

let asked = 0;
/** One query, from an address of its own: these suites ask more than the 600 a minute one client may. */
function ask(app: FastifyInstance, spec: object, key = READ_KEY) {
  const n = asked++;
  return app.inject({
    method: 'POST',
    url: '/v1/query',
    headers: { authorization: `Bearer ${key}` },
    payload: spec,
    remoteAddress: `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`,
  });
}

/** Asks both collectors every spec; returns PostgreSQL's answers once MongoDB's are found equal. */
async function same(specs: ({ kind: string } & object)[], key?: string): Promise<Answer[]> {
  const mismatches: string[] = [];
  const answers: Answer[] = [];
  for (const spec of specs) {
    const [a, b] = await Promise.all([ask(pg.app, spec, key), ask(mg.app, spec, key)]);
    if (a.statusCode !== b.statusCode) {
      mismatches.push(`${JSON.stringify(spec)}: status ${a.statusCode} ≠ ${b.statusCode} (${b.body.slice(0, 300)})`);
      continue;
    }
    if (a.statusCode !== 200) {
      // Only a spec the query code refuses, before any store is asked (a minute series over two days).
      if (a.statusCode !== 400) mismatches.push(`${JSON.stringify(spec)}: PostgreSQL answered ${a.body}`);
      expect(b.json()).toEqual(a.json());
      answers.push({ status: a.statusCode, ...a.json() });
      continue;
    }
    const [pgAnswer, mongoAnswer] = [a.json() as Answer, b.json() as Answer];
    // `from` can be the app's raw retention back from each collector's clock, read milliseconds apart.
    const from = [pgAnswer, mongoAnswer].map((x) => Date.parse(String(x.from)));
    if (spec.kind === 'reliability' && Math.abs(from[0]! - from[1]!) < MINUTE) mongoAnswer.from = pgAnswer.from;
    const diff = differences(settle(spec.kind, pgAnswer), settle(spec.kind, mongoAnswer));
    if (diff.length > 0) mismatches.push(`${JSON.stringify(spec)}\n    ${diff.slice(0, 8).join('\n    ')}`);
    answers.push(pgAnswer);
  }
  expect(mismatches, mismatches.join('\n')).toEqual([]);
  return answers;
}

describe('MongoDB answers as PostgreSQL does', () => {
  it('servers: every filter, sort and page', async () => {
    const specs: object[] = [{ kind: 'servers' }];
    for (const sort of ['members', 'joined', 'last_active', 'runs', 'name']) {
      for (const order of ['asc', 'desc']) {
        specs.push({ kind: 'servers', status: 'all', sort, order });
        for (const offset of [0, 4, 9, 30]) specs.push({ kind: 'servers', sort, order, limit: 4, offset });
      }
    }
    for (const status of ['active', 'left', 'all']) {
      specs.push(
        { kind: 'servers', status, search: 'éCL' },
        { kind: 'servers', status, search: "o'brien %_\\", sort: 'runs' },
        { kind: 'servers', status, search: 'same', sort: 'name', order: 'asc' },
        { kind: 'servers', status, search: '_', sort: 'members' },
        { kind: 'servers', status, search: 'nothing like this' },
        { kind: 'servers', status, feature: 'PARTNERED' },
        { kind: 'servers', status, locale: 'de', sort: 'joined', order: 'asc' },
        { kind: 'servers', status, inactive: true, sort: 'last_active' },
        { kind: 'servers', status, missingPermissions: true, sort: 'name' },
        { kind: 'servers', status, missingPermissions: true, inactive: true, sort: 'runs', order: 'asc' },
      );
      for (const size of ['1-10', '11-100', '101-1k', '1k-10k', '10k+']) {
        specs.push({ kind: 'servers', status, size, sort: 'name', order: 'desc' });
      }
    }
    const answers = await same(specs as { kind: string }[]);
    const all = answers[1] as { total: number; rows: { id: string }[] };
    expect(all.total).toBeGreaterThan(15);
    expect((answers[0] as { rows: { runs: number }[] }).rows.some((r) => r.runs > 0)).toBe(true);
  });

  it('server: every server, and one never seen', async () => {
    const ids = [...JOINED.map((g) => g.id), '2423456789012345678', '2523456789012345678', '3023456789012345678'];
    const answers = await same([...ids, '998877665544332211'].map((guild) => ({ kind: 'server', guild })));
    expect(answers.filter((a) => a.found).length).toBe(ids.length);
  });

  it('guild names, from the server profiles the store has', async () => {
    const ids = [...JOINED.map((g) => g.id), '998877665544332211'];
    const sorted = (names: { id: string }[]) => [...names].sort((x, y) => (x.id < y.id ? -1 : 1));
    const [a, b] = await Promise.all([pg.store.query.guildNames(APP_ID, ids), mg.store.query.guildNames(APP_ID, ids)]);
    expect(sorted(b)).toEqual(sorted(a));
    expect(a).toHaveLength(JOINED.length);
    expect(await mg.store.query.guildNames(APP_ID, [])).toEqual([]);
  });

  it('growth: every range, in every time zone', async () => {
    const specs = Object.values(RANGES).flatMap((r) =>
      ZONES.map((timezone) => ({ kind: 'growth', range: r, timezone })),
    );
    const answers = await same(specs);
    const quarter = answers[specs.findIndex((spec) => spec.range === RANGES.quarter && spec.timezone === 'UTC')] as {
      lifetimes: unknown[];
      cohorts: unknown[];
      sizeAtInstall: unknown[];
    };
    expect(quarter.lifetimes).toHaveLength(5);
    expect(quarter.sizeAtInstall).toHaveLength(5);
    expect(quarter.cohorts.length).toBeGreaterThan(5);
  });

  it('audience: every range', async () => {
    const answers = await same(Object.values(RANGES).map((r) => ({ kind: 'audience', range: r })));
    const quarter = answers[Object.keys(RANGES).indexOf('quarter')] as {
      periods: unknown[];
      weekly: unknown[];
      splits: Record<string, unknown[]>;
    };
    expect(quarter.periods.length).toBeGreaterThan(2);
    expect(Object.keys(quarter.splits).sort()).toEqual(['context', 'install', 'locale', 'tier']);
  });

  it('gauge: every gauge, interval and time zone, per shard or not', async () => {
    const names = [
      'shard.ping_ms',
      'shard.guilds',
      'memory.rss_bytes',
      'eventloop.p99_ms',
      'cache.users',
      'app.approx_guilds',
      'none',
    ];
    const specs: object[] = [];
    for (const name of names) {
      for (const perShard of [false, true]) {
        specs.push(
          { kind: 'gauge', name, interval: 'minute', range: range(3 * HOUR), perShard },
          { kind: 'gauge', name, interval: 'minute', range: range(2 * DAY), perShard },
          { kind: 'gauge', name, interval: 'day', range: RANGES.month, perShard },
        );
        for (const timezone of ZONES) {
          specs.push(
            { kind: 'gauge', name, interval: 'hour', range: RANGES.week, perShard, timezone },
            ...DST_ZONES.map((zone) => ({
              kind: 'gauge',
              name,
              interval: 'hour',
              range: RANGES[zone],
              perShard,
              timezone,
            })),
            { kind: 'gauge', name, interval: 'day', range: RANGES['Europe/London'], perShard, timezone },
          );
        }
      }
    }
    specs.push({ kind: 'gauge', name: 'shard.ping_ms', interval: 'minute', range: RANGES.week });
    const answers = await same(specs as { kind: string }[]);
    expect(answers.some((a) => (a.points as unknown[]).length > 100)).toBe(true);
  });

  it('bursts: every range and factor', async () => {
    const specs = [RANGES.day, RANGES.week, RANGES.month, RANGES.long].flatMap((r) =>
      [2, 5, 10].map((factor) => ({ kind: 'bursts', range: r, factor })),
    );
    const answers = await same(specs);
    expect((answers[3] as { rows: unknown[] }).rows.length).toBeGreaterThan(0);
  });

  it('reliability: every range', async () => {
    const answers = await same(Object.values(RANGES).map((r) => ({ kind: 'reliability', range: r })));
    const month = answers[Object.keys(RANGES).indexOf('month')] as {
      routes: unknown[];
      errorsByCode: unknown[];
      sdkInstances: unknown[];
      process: object;
    };
    expect(month.routes.length).toBeGreaterThan(3);
    expect(month.errorsByCode.length).toBeGreaterThan(2);
    expect(Object.keys(month.process)).toHaveLength(3);
  });

  it('premium: every range', async () => {
    const answers = await same(Object.values(RANGES).map((r) => ({ kind: 'premium', range: r })));
    expect(
      (answers[Object.keys(RANGES).indexOf('ingested')] as { subscriptions: unknown[] }).subscriptions,
    ).toHaveLength(3);
  });

  it('installs: every range, in every time zone', async () => {
    await same(
      Object.values(RANGES).flatMap((r) => ZONES.map((timezone) => ({ kind: 'installs', range: r, timezone }))),
    );
  });

  it('badges, read by the store and served by the badge route', async () => {
    for (const metric of ['servers', 'users-monthly', 'commands-daily', 'unknown']) {
      expect(await mg.store.query.badge(APP_ID, metric), metric).toBe(await pg.store.query.badge(APP_ID, metric));
      const badge = (h: Harness) => h.app.inject({ method: 'GET', url: `/v1/badge/${metric}.svg` });
      const [a, b] = await Promise.all([badge(pg), badge(mg)]);
      expect(b.statusCode).toBe(a.statusCode);
      expect(b.body).toBe(a.body);
    }
    expect(await mg.store.query.badge(APP_ID, 'servers')).toBeGreaterThan(10);
    expect(await mg.store.query.badge(EMPTY_APP, 'users-monthly')).toBeNull();
    expect(await mg.store.query.badge(EMPTY_APP, 'commands-daily')).toBe(0);
  });

  it('an app with no data at all', async () => {
    const specs: object[] = [
      { kind: 'servers' },
      { kind: 'servers', sort: 'runs' },
      { kind: 'servers', sort: 'name', missingPermissions: true },
      { kind: 'server', guild: JOINED[0]!.id },
      { kind: 'gauge', name: 'shard.ping_ms', interval: 'hour', range: RANGES.week },
    ];
    for (const kind of ['growth', 'audience', 'bursts', 'reliability', 'premium', 'installs']) {
      specs.push({ kind, range: RANGES.month }, { kind, range: RANGES.long });
    }
    await same(specs as { kind: string }[], EMPTY_READ_KEY);
  });
});
