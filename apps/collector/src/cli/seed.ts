/**
 * Demo data: 30 days of fictional bot traffic sent through the real SDK client, then rollups backfilled. For local
 * development, screenshots and the public demo. Every server name, user and number here is made up.
 */
import { periodLabel, ShardlensClient, uuidv7, type WireEvent } from '@shardlens/core';
import { createPool } from '../db.js';
import { backfillRollups, runUniques } from '../jobs/rollups.js';
import { ensureSalt, RETENTION_DAYS } from '../storage/maintenance.js';
import { previousPeriodLabel } from '../storage/periods.js';

const env = (name: string, fallback?: string) => {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`${name} is required`);
  return v;
};

const DAY = 86_400_000;
const SHARDS = 2;
let seed = 0x5eed;
/** Deterministic PRNG so every seeded instance looks the same. */
const rand = () => {
  seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
const weighted = <T>(items: readonly [T, number][]): T => {
  const total = items.reduce((a, [, w]) => a + w, 0);
  let r = rand() * total;
  for (const [item, w] of items) {
    r -= w;
    if (r <= 0) return item;
  }
  return items[0]![0];
};
const lognormal = (median: number, sigma: number) => {
  const u = Math.max(1e-9, rand());
  const v = rand();
  return median * Math.exp(sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
};
const snowflake = (at: number) =>
  (((BigInt(Math.floor(at)) - 1420070400000n) << 22n) + BigInt(Math.floor(rand() * 4_000_000))).toString();
const shardOf = (id: string) => Number((BigInt(id) >> 22n) % BigInt(SHARDS));

const NAMES = [
  'Pixel Pals',
  'Night Owls Gaming',
  'The Study Hall',
  'Cosy Corner',
  'Retro Arcade Club',
  'Lo-fi Lounge',
  'Speedrun Society',
  'Book Nook',
  'Dev Den',
  'Art Attack',
  'Tabletop Tavern',
  'Plant Parents',
  'Chess Club Central',
  'Anime Alley',
  'Fitness Friends',
  'Language Exchange',
  'Synthwave Station',
  'Puzzle Palace',
  'Film Buffs',
  'Indie Game Lab',
  'Cat Cafe',
  'Puzzle Hunters',
  'Weekend Raiders',
  'Math Help',
  'Photography Spot',
  'Minecraft Builders',
  'Karaoke Night',
  'Trivia Time',
  'Sneaker Talk',
  'Space Nerds',
  'Cooking Corner',
  'Music Producers',
  'Hiking Buddies',
  'Board Game Bunch',
  'Coffee Chat',
  'Late Night Coders',
  'Garden Club',
  'Meme Machine',
  'Writers Room',
  'Esports Arena',
  'Bird Watchers',
  'Aquarium Club',
  'Comic Collectors',
  'Study Buddies UK',
  'Open Source Hangout',
  'Vinyl Collectors',
  'Drawing Practice',
  'Tech Support Hub',
  'Running Club',
  'Quiet Reading Room',
  'Strategy Gamers',
  'Homebrew Hub',
  'Climbing Crew',
  'Movie Night',
  'Sim Racing League',
  'Rhythm Gamers',
  'Cozy Crafters',
  'Robotics Team',
  'Debate Society',
  'Pet Pics',
] as const;
const LOCALES: [string, number][] = [
  ['en-US', 40],
  ['en-GB', 18],
  ['de', 9],
  ['fr', 7],
  ['es-ES', 6],
  ['pt-BR', 6],
  ['pl', 4],
  ['ja', 3],
  ['nl', 3],
  ['tr', 2],
  ['ko', 2],
];
const COMMANDS: { name: string; subs: string[]; weight: number; defer: number; ephemeral: number; slow: number }[] = [
  { name: 'ticket', subs: ['open', 'close', 'claim'], weight: 30, defer: 0.1, ephemeral: 0.2, slow: 0.01 },
  { name: 'help', subs: [], weight: 18, defer: 0, ephemeral: 0.9, slow: 0.002 },
  { name: 'music', subs: ['play', 'skip', 'queue'], weight: 22, defer: 0.75, ephemeral: 0, slow: 0.04 },
  { name: 'poll', subs: ['create', 'end'], weight: 10, defer: 0.05, ephemeral: 0, slow: 0.01 },
  { name: 'profile', subs: ['view', 'edit'], weight: 9, defer: 0.2, ephemeral: 0.5, slow: 0.02 },
  { name: 'settings', subs: [], weight: 4, defer: 0, ephemeral: 1, slow: 0.005 },
  { name: 'rank', subs: [], weight: 7, defer: 0.6, ephemeral: 0, slow: 0.06 },
];

async function main() {
  const db = createPool(env('DATABASE_URL'));
  const appId = env('SHARDLENS_APP_ID');
  const now = Date.now();
  const start = now - 30 * DAY;
  // Gauges are kept for less than the history seeded here; older ones would be refused. The hour of margin covers
  // the time the seeding itself takes.
  const oldestGauge = now - ((RETENTION_DAYS.gauges as number) - 1) * DAY + 3_600_000;

  // Fictional data must never be mixed into a real bot's analytics.
  const existing = await db.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM (SELECT 1 FROM interactions WHERE app_id = $1 LIMIT 1) x',
    [appId],
  );
  if ((existing.rows[0]?.n ?? 0) > 0 && !process.argv.includes('--force')) {
    console.error(
      'This database already has interactions. The seeder only fills empty demo databases (--force to add anyway).',
    );
    await db.end();
    process.exitCode = 1;
    return;
  }

  // The demo spans the previous salt period too, so make sure its salt exists (it normally would already).
  await db.query('INSERT INTO apps (app_id, name) VALUES ($1, $2) ON CONFLICT (app_id) DO NOTHING', [
    appId,
    'Demo bot',
  ]);
  await ensureSalt(db, appId, periodLabel('month', new Date(now)));
  const previous = previousPeriodLabel('month', new Date(now));
  await ensureSalt(db, appId, previous);
  // Demo only: last month's salt may already be past its 7-day grace window. Keep it alive for an hour so last
  // month's demo users can be hashed; the salt job then destroys it as usual (finalising its counts).
  await db.query(
    `UPDATE salts SET destroy_after = greatest(destroy_after, now() + interval '1 hour')
      WHERE app_id = $1 AND period = $2 AND secret IS NOT NULL`,
    [appId, previous],
  );

  const client = new ShardlensClient<WireEvent>({
    endpoint: env('SHARDLENS_URL', 'http://localhost:8080'),
    apiKey: env('SHARDLENS_INGEST_KEY'),
    sdk: { name: '@shardlens/seed', version: '0.0.0' },
    release: '2.4.1',
    maxQueueSize: 20_000,
    flushIntervalMs: 60_000,
    source: () => ({ shards: [0, 1], instance: 'demo-bot:1' }),
    // Report collector rejections so a bad seed is obvious.
    fetch: async (input, init) => {
      const res = await fetch(input, init);
      if (String(input).endsWith('/v1/ingest')) {
        const body = (await res
          .clone()
          .json()
          .catch(() => ({}))) as { rejected?: { reason: string }[] };
        const reasons = new Map<string, number>();
        for (const r of body.rejected ?? []) reasons.set(r.reason, (reasons.get(r.reason) ?? 0) + 1);
        if (res.status !== 202 || reasons.size > 0) console.warn(`ingest ${res.status}`, Object.fromEntries(reasons));
      }
      return res;
    },
  });
  for (let i = 0; i < 100 && !client.ready; i++) await new Promise((r) => setTimeout(r, 50));
  if (!client.ready) throw new Error('could not load /v1/config: check SHARDLENS_URL and SHARDLENS_INGEST_KEY');

  let sent = 0;
  const push = async (event: WireEvent, priority: 0 | 1 | 2 | 3 = 3) => {
    client.enqueue(event, priority);
    if (++sent % 2_000 === 0) await client.flush();
  };
  const pushUser = async (userId: string, ts: number, build: (user: string) => WireEvent) => {
    client.enqueueWithUser(userId, ts, 3, build);
    if (++sent % 2_000 === 0) {
      await new Promise((r) => setTimeout(r, 20));
      await client.flush();
    }
  };

  type Server = {
    id: string;
    name: string;
    members: number;
    joinedAt: number;
    leftAt?: number;
    locale: string;
    baseline: boolean;
  };
  const servers: Server[] = NAMES.map((name, i) => {
    const baseline = i < 44;
    const joinedAt = baseline ? now - (40 + rand() * 300) * DAY : start + rand() * 29 * DAY;
    return {
      id: snowflake(now - (400 + rand() * 1500) * DAY),
      name,
      members: Math.max(3, Math.round(lognormal(120, 1.6))),
      joinedAt,
      locale: weighted(LOCALES),
      baseline,
    };
  });
  for (const s of servers.filter((x) => !x.baseline).slice(0, 4)) s.leftAt = s.joinedAt + (0.2 + rand() * 6) * DAY;
  for (const s of servers.filter((x) => x.baseline).slice(0, 3)) s.leftAt = start + rand() * 28 * DAY;

  const info = (s: Server) => ({
    guild: s.id,
    name: s.name,
    icon: null,
    memberCount: s.members,
    large: s.members > 250,
    preferredLocale: s.locale,
    features: s.members > 500 ? ['COMMUNITY', 'NEWS'] : s.members > 100 ? ['COMMUNITY'] : [],
    premiumTier: s.members > 1000 ? 2 : s.members > 300 ? 1 : 0,
    boosts: s.members > 300 ? Math.round(s.members / 150) : 0,
    verificationLevel: 1,
    nsfwLevel: 0,
    mfaLevel: 0,
    createdAt: Number((BigInt(s.id) >> 22n) + 1420070400000n),
    joinedAt: Math.round(s.joinedAt),
    shard: shardOf(s.id),
    channelCounts: {
      '0': 4 + Math.round(rand() * 20),
      '2': 1 + Math.round(rand() * 6),
      '4': 2 + Math.round(rand() * 4),
    },
    roleCount: 3 + Math.round(rand() * 25),
    emojiCount: Math.round(rand() * 40),
    stickerCount: Math.round(rand() * 5),
    botPermissions: rand() < 0.1 ? '2048' : '277025770560',
  });

  // Baseline snapshot 31 days ago: servers that already had the bot when Shardlens was installed.
  const baseline = servers.filter((s) => s.baseline);
  for (let shard = 0; shard < SHARDS; shard++) {
    await push({
      id: uuidv7(start - DAY),
      ts: start - DAY,
      type: 'guild_snapshot',
      shards: [shard],
      shardCount: SHARDS,
      guilds: baseline.filter((s) => shardOf(s.id) === shard).map((s) => s.id),
    } as WireEvent);
  }
  await client.flush();
  for (const s of servers) {
    if (!s.baseline) {
      await push({
        id: uuidv7(s.joinedAt),
        ts: Math.round(s.joinedAt),
        type: 'guild_join',
        info: info(s),
        detectedAtStartup: false,
      } as WireEvent);
    } else {
      await push({ id: uuidv7(start), ts: start, type: 'guild_update', info: info(s) } as WireEvent, 1);
    }
    if (s.leftAt) {
      await push({
        id: uuidv7(s.leftAt),
        ts: Math.round(s.leftAt),
        type: 'guild_leave',
        guild: s.id,
        detectedAtStartup: rand() < 0.3,
      } as WireEvent);
    }
  }

  const users = Array.from({ length: 700 }, (_, i) => ({
    id: snowflake(now - (100 + i * 3) * DAY),
    locale: weighted(LOCALES),
    home: servers[Math.floor(rand() * servers.length)]!,
    premium: rand() < 0.06,
  }));

  const ticketMessages: { id: string; ts: number }[] = [];
  for (let day = 0; day < 30; day++) {
    const dayStart = start + day * DAY;
    const weekday = new Date(dayStart).getUTCDay();
    const volume = Math.round((380 + day * 9) * (weekday === 0 || weekday === 6 ? 1.35 : 1) * (0.9 + rand() * 0.2));
    for (let n = 0; n < volume; n++) {
      const hour = weighted([
        [0, 2],
        [3, 1],
        [6, 1],
        [9, 3],
        [12, 5],
        [15, 7],
        [17, 9],
        [19, 10],
        [21, 8],
        [23, 4],
      ] as [number, number][]);
      const ts = Math.round(dayStart + (hour + rand() * 3) * 3_600_000);
      if (ts > now - 60_000) continue;
      const user = rand() < 0.75 ? users[Math.floor(rand() * 120)]! : pick(users);
      const server = rand() < 0.7 ? user.home : pick(servers);
      if (ts < server.joinedAt || (server.leftAt && ts > server.leftAt)) continue;
      const cmd = weighted(COMMANDS.map((c) => [c, c.weight] as [typeof c, number]));
      const sub = cmd.subs.length ? pick(cmd.subs) : undefined;
      const installRoll = rand();
      const install = installRoll < 0.88 ? 'guild' : installRoll < 0.97 ? 'user' : 'both';
      const outcomeRoll = rand();
      const slow = rand() < cmd.slow;
      const outcome = slow ? 'timeout' : outcomeRoll < 0.022 ? 'error' : outcomeRoll < 0.03 ? 'no_response' : 'ok';
      const deferred = rand() < cmd.defer;
      const ack = slow ? 3_000 + rand() * 1_500 : deferred ? lognormal(90, 0.5) : lognormal(220, 0.7);
      const id = uuidv7(ts);
      const isSettings = cmd.name === 'settings';
      await pushUser(
        user.id,
        ts,
        (hash) =>
          ({
            id,
            ts,
            type: 'interaction',
            kind: 'chat_input',
            command: cmd.name,
            ...(sub ? { sub } : {}),
            commandId: '1100000000000000000',
            commandScope: 'global',
            options:
              cmd.name === 'ticket' && sub === 'open'
                ? ['category']
                : cmd.name === 'music' && sub === 'play'
                  ? ['query']
                  : [],
            ...(cmd.name === 'ticket' && sub === 'open'
              ? {
                  optionValues: {
                    category: weighted([
                      ['billing', 3],
                      ['support', 5],
                      ['report', 2],
                    ] as [string, number][]),
                  },
                }
              : {}),
            context: install === 'user' && rand() < 0.5 ? 1 : 0,
            install,
            guild: server.id,
            channelType: weighted([
              [0, 76],
              [11, 12],
              [15, 5],
              [2, 4],
              [5, 3],
            ] as [number, number][]),
            locale: user.locale,
            guildLocale: server.locale,
            memberTier: weighted([
              ['member', 85],
              ['manager', 8],
              ['admin', 7],
            ] as [string, number][]),
            user: hash,
            premium: user.premium,
            outcome,
            ...(outcome === 'timeout' ? { errorCode: 10062 } : {}),
            ...(outcome === 'error' ? { errorClass: pick(['TypeError', 'DiscordAPIError', 'RangeError']) } : {}),
            ...(outcome !== 'no_response' ? { ackMs: Math.round(ack) } : {}),
            responseType: isSettings ? 9 : deferred ? 5 : 4,
            ...(isSettings ? { customId: 'settings:modal' } : {}),
            deferred,
            ephemeral: rand() < cmd.ephemeral,
            handlerMs: Math.round(ack * (1 + rand() * 2)),
            shard: shardOf(server.id),
          }) as WireEvent,
      );

      if (cmd.name === 'ticket' && sub === 'open') {
        ticketMessages.push({ id, ts });
        if (rand() < 0.8) {
          const clickTs = Math.round(Math.min(now - 30_000, ts + lognormal(600_000, 1)));
          await pushUser(
            user.id,
            clickTs,
            (hash) =>
              ({
                id: uuidv7(clickTs),
                ts: clickTs,
                type: 'interaction',
                kind: 'button',
                customId: 'ticket:close:*',
                componentType: 2,
                sourceCommand: 'ticket',
                install,
                guild: server.id,
                locale: user.locale,
                memberTier: 'member',
                user: hash,
                premium: user.premium,
                outcome: 'ok',
                ackMs: Math.round(lognormal(150, 0.5)),
                responseType: 7,
                deferred: false,
                ephemeral: false,
                options: [],
              }) as WireEvent,
          );
        }
        const category = pick(['billing', 'support', 'report']);
        await pushUser(
          user.id,
          ts,
          (hash) =>
            ({
              id: uuidv7(ts),
              ts,
              type: 'custom',
              name: 'ticket_opened',
              props: { category },
              user: hash,
              guild: server.id,
            }) as WireEvent,
        );
        // Most tickets get closed by the same person, a few minutes to a day later (for the demo funnel).
        if (rand() < 0.65) {
          const closedTs = Math.round(Math.min(now - 30_000, ts + lognormal(90 * 60_000, 1.2)));
          await pushUser(
            user.id,
            closedTs,
            (hash) =>
              ({
                id: uuidv7(closedTs),
                ts: closedTs,
                type: 'custom',
                name: 'ticket_closed',
                props: { category, resolved: rand() < 0.8 },
                user: hash,
                guild: server.id,
              }) as WireEvent,
          );
        }
      }
      if (cmd.name === 'poll' && sub === 'create') {
        for (let v = 0; v < 1 + Math.floor(rand() * 6); v++) {
          const voteTs = Math.round(Math.min(now - 30_000, ts + rand() * 3_600_000));
          const voter = pick(users);
          await pushUser(
            voter.id,
            voteTs,
            (hash) =>
              ({
                id: uuidv7(voteTs),
                ts: voteTs,
                type: 'interaction',
                kind: 'select',
                customId: 'poll:vote:*',
                componentType: 3,
                sourceCommand: 'poll',
                install: 'guild',
                guild: server.id,
                locale: voter.locale,
                memberTier: 'member',
                user: hash,
                premium: voter.premium,
                outcome: 'ok',
                ackMs: Math.round(lognormal(120, 0.4)),
                options: [],
              }) as WireEvent,
          );
        }
      }
      if (isSettings && rand() < 0.72) {
        const submitTs = Math.round(Math.min(now - 30_000, ts + lognormal(40_000, 0.6)));
        await pushUser(
          user.id,
          submitTs,
          (hash) =>
            ({
              id: uuidv7(submitTs),
              ts: submitTs,
              type: 'interaction',
              kind: 'modal_submit',
              customId: 'settings:modal',
              install,
              guild: server.id,
              locale: user.locale,
              memberTier: 'member',
              user: hash,
              premium: user.premium,
              outcome: 'ok',
              ackMs: Math.round(lognormal(200, 0.5)),
              options: [],
            }) as WireEvent,
        );
      }
    }

    for (let w = 0; w < 24; w++) {
      const ts = Math.min(now - 60_000, dayStart + w * 3_600_000 + 1_000);
      const hist = (median: number, n: number) => {
        const h = new Array<number>(40).fill(0);
        for (let k = 0; k < n; k++) {
          const ms = lognormal(median, 0.6);
          const b = ms <= 1 ? 0 : Math.min(39, Math.max(0, Math.floor((Math.log(ms) / Math.log(60_000)) * 39)));
          h[b] = (h[b] ?? 0) + 1;
        }
        return h;
      };
      const callbacks = 10 + Math.round(rand() * 30);
      const messages = 5 + Math.round(rand() * 20);
      await push(
        {
          id: uuidv7(ts),
          ts,
          type: 'rest_window',
          windowMs: 3_600_000,
          rows: [
            {
              method: 'POST',
              route: '/interactions/:id/:token/callback',
              status: 204,
              count: callbacks,
              retries: 0,
              latency: hist(110, callbacks),
            },
            {
              method: 'POST',
              route: '/channels/:id/messages',
              status: 200,
              count: messages,
              retries: 0,
              latency: hist(160, messages),
            },
            {
              method: 'PATCH',
              route: '/webhooks/:id/:token/messages/@original',
              status: 200,
              count: 4,
              retries: 0,
              latency: hist(140, 4),
            },
            ...(rand() < 0.2
              ? [
                  {
                    method: 'POST',
                    route: '/channels/:id/messages',
                    status: 429,
                    count: 1,
                    retries: 1,
                    latency: hist(90, 1),
                  },
                ]
              : []),
            ...(rand() < 0.1
              ? [
                  {
                    method: 'GET',
                    route: '/guilds/:id/members/:id',
                    status: 403,
                    count: 2,
                    retries: 0,
                    latency: hist(80, 2),
                  },
                ]
              : []),
          ],
          invalid: { count401: 0, count403: rand() < 0.1 ? 2 : 0, count429: rand() < 0.2 ? 1 : 0, shared429: 0 },
        } as WireEvent,
        1,
      );
      if (ts < oldestGauge) continue;
      await push(
        {
          id: uuidv7(ts + 5),
          ts: ts + 5,
          type: 'gauge_window',
          gauges: [
            { name: 'shard.ping_ms', shard: 0, value: Math.round(lognormal(45, 0.3)) },
            { name: 'shard.ping_ms', shard: 1, value: Math.round(lognormal(52, 0.3)) },
            {
              name: 'shard.guilds',
              shard: 0,
              value: servers.filter((s) => shardOf(s.id) === 0 && s.joinedAt < ts && !(s.leftAt && s.leftAt < ts))
                .length,
            },
            {
              name: 'shard.guilds',
              shard: 1,
              value: servers.filter((s) => shardOf(s.id) === 1 && s.joinedAt < ts && !(s.leftAt && s.leftAt < ts))
                .length,
            },
            { name: 'eventloop.p99_ms', value: Math.round(lognormal(18, 0.4)) },
            { name: 'memory.rss_bytes', value: 180_000_000 + day * 400_000 },
            { name: 'memory.heap_used_bytes', value: 90_000_000 + day * 200_000 },
          ],
        } as WireEvent,
        0,
      );
    }
  }

  await push(
    {
      id: uuidv7(),
      ts: now - 30_000,
      type: 'command_registry',
      commands: [
        ...COMMANDS.map((c, i) => ({
          id: String(1100000000000000000n + BigInt(i)),
          name: c.name,
          type: 1,
          subcommands: c.subs,
        })),
        { id: '1100000000000000099', name: 'legacy-stats', type: 1, subcommands: [] },
      ],
    } as WireEvent,
    2,
  );
  const active = servers.filter((s) => !s.leftAt).length;
  await push(
    {
      id: uuidv7(),
      ts: now - 20_000,
      type: 'app_info',
      name: 'Demo bot',
      approximateGuildCount: active,
      approximateUserInstallCount: 412,
      approximateUserAuthorizationCount: 530,
      dashboardUserIds: [],
      eventWebhooksStatus: 1,
      skus: [],
      sessionStartRemaining: 994,
      sessionStartTotal: 1000,
      nodeVersion: process.version,
      libVersion: '14.28.1',
    } as WireEvent,
    2,
  );

  await new Promise((r) => setTimeout(r, 100));
  await client.shutdown({ timeoutMs: 30_000 });
  const stats = client.stats();
  console.log(`sent ${sent} events; dropped ${JSON.stringify(stats.dropped)}; failed flushes ${stats.failedFlushes}`);

  await backfillRollups(db, new Date(start - 2 * DAY), new Date(now + 60_000), new Date());
  await db.query('DELETE FROM dirty_buckets');
  await runUniques(db, appId);
  console.log('rollups and unique counts rebuilt');
  await db.end();
  // Every event here is made to be accepted. One that wasn't is a bug in this script, and the end-to-end tests that
  // run it should fail rather than test a thinner demo.
  const lost = Object.values(stats.dropped).reduce((sum, n) => sum + n, 0);
  if (lost > 0) throw new Error(`${lost} demo events were not stored (see "dropped" above)`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
