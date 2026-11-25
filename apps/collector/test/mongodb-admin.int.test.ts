import { createHash, randomBytes } from 'node:crypto';
import { bucketOf, uuidv7 } from '@shardlens/core';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Binary, type Collection, MongoClient, UUID } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, type Db, migrate } from '../src/db.js';
import { runAlerts } from '../src/jobs/alerts.js';
import { ALERT_METRICS } from '../src/routes/admin.js';
import { auditCipher } from '../src/security/crypto.js';
import { collections, type LiveShareDoc } from '../src/storage/mongodb/collections.js';
import type { Mongo } from '../src/storage/mongodb/connect.js';
import { POSTGRES_BUCKET_UPPER_MS } from '../src/storage/mongodb/histogram.js';
import { mongoLeader } from '../src/storage/mongodb/leader.js';
import { mongoLive } from '../src/storage/mongodb/live.js';
import type { MongoStore } from '../src/storage/mongodb/store.js';
import { wallTime } from '../src/storage/mongodb/zoned-time.js';
import { PostgresStore } from '../src/storage/postgres/store.js';
import type { LiveShare, ReportToSend, Store } from '../src/storage/store.js';
import { mongoStore } from './harness.js';

/*
 * MongoStore's admin side: keys, sessions, settings, alerts, reports, privacy, the admin audit, live tiles and the job
 * leader, and the single-event reads a sampled bot's weights reach. Where PostgreSQL computes an answer from the same
 * rows, the same scenario runs through `PostgresStore` too and the answers must be equal, down to the last bit of a
 * float.
 */

const DAY = 86_400_000;
const WEBHOOK = Buffer.from('sealed webhook');

let backing: Awaited<ReturnType<typeof mongoStore>>;
let mongo: Store;
let m: Mongo;
let container: StartedPostgreSqlContainer;
let db: Db;
let pg: PostgresStore;
let appSeq = 0;

/** A new app in both stores. */
async function addApp(opts: { timezone?: string; name?: string } = {}): Promise<string> {
  const appId = String(3_000_000_000_000_000_000n + BigInt(++appSeq));
  for (const store of [pg, mongo]) {
    await store.apps.register(appId, opts.name);
    if (opts.timezone) await store.apps.update(appId, { timezone: opts.timezone });
  }
  return appId;
}

async function addAppInfo(appId: string, info: { name: string; sessionStartRemaining?: number }) {
  await db.query('INSERT INTO app_info (app_id, ts, name, session_start_remaining) VALUES ($1, now(), $2, $3)', [
    appId,
    info.name,
    info.sessionStartRemaining ?? null,
  ]);
  await m.c.appInfo.insertOne({
    _id: appId,
    ts: new Date(),
    name: info.name,
    dashboardUserIds: [],
    skus: [],
    ...(info.sessionStartRemaining !== undefined && { sessionStartRemaining: info.sessionStartRemaining }),
  });
}

interface Run {
  /** Milliseconds before now. */
  ago: number;
  kind?: number;
  command?: string;
  outcome?: number;
  ackMs?: number;
  weight?: number;
  userHash?: Buffer;
}

/** The same interactions in both stores. */
async function addInteractions(appId: string, runs: Run[]) {
  const now = Date.now();
  for (const r of runs) {
    const ts = now - r.ago;
    const id = uuidv7(ts);
    const userHash = r.userHash ?? Buffer.alloc(16, 1);
    await db.query(
      `INSERT INTO interactions (id, ts, app_id, env, kind, command, locale, user_hash, salt_period, premium, outcome,
                                 ack_ms, weight)
       VALUES ($1, $2, $3, 'production', $4, $5, 'en-GB', $6, '2026-11', false, $7, $8, $9)`,
      [
        id,
        new Date(ts),
        appId,
        r.kind ?? 1,
        r.command ?? null,
        userHash,
        r.outcome ?? 0,
        r.ackMs ?? null,
        r.weight ?? 1,
      ],
    );
    await m.c.interactions.insertOne({
      _id: new UUID(id),
      ts: new Date(ts),
      appId,
      env: 'production',
      kind: r.kind ?? 1,
      ...(r.command !== undefined && { command: r.command }),
      options: [],
      locale: 'en-GB',
      userHash: new Binary(userHash),
      saltPeriod: '2026-11',
      premium: false,
      outcome: r.outcome ?? 0,
      ...(r.ackMs !== undefined && { ackMs: r.ackMs }),
      // As ingest stores it: PostgreSQL's `real`.
      weight: Math.fround(r.weight ?? 1),
    });
  }
}

/** The same custom events in both stores, one a minute going back from now. */
async function addCustomEvents(
  appId: string,
  events: { name: string; props: Record<string, string | number | boolean>; weight: number }[],
) {
  const now = Date.now();
  for (const [i, e] of events.entries()) {
    const ts = new Date(now - (i + 1) * 60_000);
    const id = uuidv7(ts.getTime());
    const userHash = Buffer.alloc(16, i % 3);
    await db.query(
      'INSERT INTO custom_events (id, ts, app_id, name, props, user_hash, weight) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [id, ts, appId, e.name, JSON.stringify(e.props), userHash, e.weight],
    );
    await m.c.customEvents.insertOne({
      _id: new UUID(id),
      ts,
      appId,
      name: e.name,
      props: e.props,
      userHash: new Binary(userHash),
      weight: Math.fround(e.weight),
    });
  }
}

async function addPing(appId: string, shard: number, ago: number, value: number, instance = 'a') {
  const ts = new Date(Date.now() - ago);
  await db.query(
    "INSERT INTO gauges (app_id, ts, name, shard, instance, value) VALUES ($1, $2, 'shard.ping_ms', $3, $4, $5)",
    [appId, ts, shard, instance, value],
  );
  await m.c.gauges.insertOne({ _id: { appId, name: 'shard.ping_ms', shard, instance, ts }, value });
}

async function addGuild(appId: string, guildId: string, opts: { name?: string; left?: boolean } = {}) {
  await db.query('INSERT INTO guilds (app_id, guild_id, name, joined_at, left_at) VALUES ($1, $2, $3, now(), $4)', [
    appId,
    guildId,
    opts.name ?? '',
    opts.left ? new Date() : null,
  ]);
  const now = new Date();
  await m.c.guilds.insertOne({
    _id: { appId, guildId },
    name: opts.name ?? '',
    memberCount: 0,
    features: [],
    joinedAt: now,
    ...(opts.left && { leftAt: now }),
    detectedAtStartup: false,
    baseline: false,
    updatedAt: now,
  });
}

beforeAll(async () => {
  const [mb, pgc] = await Promise.all([
    mongoStore(),
    new PostgreSqlContainer(process.env.SHARDLENS_TEST_PG_IMAGE ?? 'postgres:16-alpine').start(),
  ]);
  backing = mb;
  mongo = mb.store;
  m = (mb.store as MongoStore).mongo;
  container = pgc;
  await migrate(pgc.getConnectionUri());
  db = createPool(pgc.getConnectionUri(), 4);
  pg = new PostgresStore(db);
  await Promise.all([mongo.prepare(), pg.prepare()]);
});

afterAll(async () => {
  await backing?.close();
  await db?.end();
  await container?.stop();
});

describe('latency histograms', () => {
  it('buckets every whole millisecond as PostgreSQL does, and gives its upper bounds to the last bit', async () => {
    const buckets = await db.query<{ ms: number; b: number }>(
      'SELECT g AS ms, shardlens_bucket(g) AS b FROM generate_series(0, 120000) AS g',
    );
    expect(buckets.rows.filter((r) => r.b !== bucketOf(r.ms))).toEqual([]);
    const bounds = await db.query<{ v: number }>(
      'SELECT exp(i::double precision / 39 * ln(60000)) AS v FROM generate_series(1, 40) AS i ORDER BY i',
    );
    expect(POSTGRES_BUCKET_UPPER_MS).toEqual(bounds.rows.map((r) => r.v));
  });
});

describe('keys', () => {
  const digest = (key: string) => createHash('sha256').update(key).digest();

  it('stores only the digest, lists newest first, and stops finding a key once it is revoked', async () => {
    const appId = await addApp();
    const ingest = await mongo.keys.create({ appId, scope: 'ingest', sha256: digest('k1'), label: 'bot' });
    const read = await mongo.keys.create({ appId, scope: 'read', sha256: digest('k2'), label: 'friend' });
    expect(Number(read)).toBeGreaterThan(Number(ingest));
    expect(await mongo.keys.findActive(digest('k1'))).toEqual({ id: ingest, appId, scope: 'ingest' });
    expect(await mongo.keys.findActive(digest('nope'))).toBeUndefined();
    expect((await mongo.keys.activeScopes(appId)).sort()).toEqual(['ingest', 'read']);

    await mongo.keys.touch(ingest);
    const listed = await mongo.keys.list(appId);
    expect(listed.map((k) => k.id)).toEqual([read, ingest]);
    expect(listed[1]).toMatchObject({ scope: 'ingest', label: 'bot', revokedAt: null });
    expect(listed[1]?.lastUsedAt).toBeInstanceOf(Date);
    expect(JSON.stringify(listed)).not.toContain(digest('k1').toString('hex'));

    expect(await mongo.keys.revoke(appId, ingest)).toBe(true);
    expect(await mongo.keys.revoke(appId, ingest)).toBe(false);
    expect(await mongo.keys.revoke('1', read)).toBe(false);
    expect(await mongo.keys.findActive(digest('k1'))).toBeUndefined();
    expect(await mongo.keys.activeScopes(appId)).toEqual(['read']);
    expect((await mongo.keys.list(appId))[1]?.revokedAt).toBeInstanceOf(Date);
  });

  it('lists keys with IDs of different lengths in number order', async () => {
    const appId = await addApp();
    const ids: string[] = [];
    for (let i = 0; i < 11; i++) {
      ids.push(await mongo.keys.create({ appId, scope: 'read', sha256: digest(`order ${i}`), label: 'x' }));
    }
    await m.c.apiKeys.updateMany({ appId }, { $set: { createdAt: new Date(0) } });
    expect((await mongo.keys.list(appId)).map((k) => k.id)).toEqual([...ids].reverse());
  });

  it("replaces a variable's key: older keys revoked, their sessions ended, each revocation audited", async () => {
    const appId = await addApp();
    const [first, second] = [digest('env first'), digest('env second')];
    const label = 'SHARDLENS_READ_KEY';
    await mongo.keys.ensureFromEnvironment({ appId, scope: 'read', sha256: first, label });
    await mongo.keys.ensureFromEnvironment({ appId, scope: 'read', sha256: first, label });
    const firstId = (await mongo.keys.findActive(first))?.id as string;
    const other = await mongo.keys.create({ appId, scope: 'read', sha256: digest('settings key'), label: 'mine' });
    const session = randomBytes(32);
    await mongo.sessions.create({
      idSha256: session,
      appId,
      userId: null,
      method: 'read_key',
      keyId: firstId,
      expiresAt: new Date(Date.now() + DAY),
    });

    await mongo.keys.ensureFromEnvironment({ appId, scope: 'read', sha256: second, label });
    expect(await mongo.keys.findActive(first)).toBeUndefined();
    expect(await mongo.keys.findActive(second)).toBeDefined();
    expect(await m.c.sessions.countDocuments({ keyId: firstId })).toBe(0);
    const audit = await m.c.adminAudit.find({ appId, action: 'key_revoke' }).toArray();
    expect(audit.map((a) => [a.userId, a.details])).toEqual([
      [undefined, { id: firstId, by: 'environment', variable: label }],
    ]);

    // An instance still started with the old value can't take the new one away, nor bring the old one back.
    await mongo.keys.ensureFromEnvironment({ appId, scope: 'read', sha256: first, label });
    expect(await mongo.keys.findActive(first)).toBeUndefined();
    expect(await mongo.keys.findActive(second)).toBeDefined();
    expect((await mongo.keys.findActive(digest('settings key')))?.id).toBe(other);
    expect(await m.c.adminAudit.countDocuments({ appId, action: 'key_revoke' })).toBe(1);
  });

  it('finishes a replacement that stopped after storing the new key', async () => {
    const appId = await addApp();
    const label = 'SHARDLENS_INGEST_KEY';
    await mongo.keys.ensureFromEnvironment({ appId, scope: 'ingest', sha256: digest('old'), label });
    // As if a start had stored the new key and stopped before revoking the old one.
    await mongo.keys.create({ appId, scope: 'ingest', sha256: digest('new'), label });
    expect(await mongo.keys.findActive(digest('old'))).toBeDefined();
    await mongo.keys.ensureFromEnvironment({ appId, scope: 'ingest', sha256: digest('new'), label });
    expect(await mongo.keys.findActive(digest('old'))).toBeUndefined();
    expect(await mongo.keys.findActive(digest('new'))).toBeDefined();
  });

  it('stores a new value once when several collectors start with it at the same moment', async () => {
    const appId = await addApp();
    const label = 'SHARDLENS_READ_KEY';
    await mongo.keys.ensureFromEnvironment({ appId, scope: 'read', sha256: digest('race old'), label });
    await Promise.all(
      Array.from({ length: 5 }, () =>
        mongo.keys.ensureFromEnvironment({ appId, scope: 'read', sha256: digest('race new'), label }),
      ),
    );
    expect(await m.c.apiKeys.countDocuments({ appId })).toBe(2);
    expect(await mongo.keys.findActive(digest('race old'))).toBeUndefined();
    expect(await m.c.adminAudit.countDocuments({ appId, action: 'key_revoke' })).toBe(1);
  });
});

describe('sessions', () => {
  it('finds a live session only, and none once its read key is revoked', async () => {
    const appId = await addApp();
    const make = async (opts: { keyId?: string; expiresIn?: number; userId?: string } = {}) => {
      const id = randomBytes(32);
      await mongo.sessions.create({
        idSha256: id,
        appId,
        userId: opts.userId ?? null,
        method: opts.userId ? 'discord' : 'read_key',
        keyId: opts.keyId ?? null,
        expiresAt: new Date(Date.now() + (opts.expiresIn ?? DAY)),
      });
      return id;
    };
    const person = await make({ userId: '987654321098765432' });
    expect(await mongo.sessions.find(person)).toEqual({ appId, userId: '987654321098765432', method: 'discord' });
    // Only what `create` is given: never a token from Discord.
    const stored = await m.c.sessions.findOne({ _id: new Binary(person) });
    expect(Object.keys(stored ?? {}).sort()).toEqual(['_id', 'appId', 'createdAt', 'expiresAt', 'method', 'userId']);

    const expired = await make({ userId: '1', expiresIn: -1_000 });
    expect(await mongo.sessions.find(expired)).toBeUndefined();

    const keyId = await mongo.keys.create({
      appId,
      scope: 'read',
      sha256: createHash('sha256').update('session key').digest(),
      label: 'friend',
    });
    const reader = await make({ keyId });
    expect(await mongo.sessions.find(reader)).toEqual({ appId, userId: null, method: 'read_key' });
    // Revoked, its sessions not deleted yet: the key's own state ends them.
    await mongo.keys.revoke(appId, keyId);
    expect(await mongo.sessions.find(reader)).toBeUndefined();

    const other = await make({ keyId: '424242' });
    expect(await mongo.sessions.find(other)).toBeDefined();
    await mongo.sessions.deleteForKey('424242');
    expect(await mongo.sessions.find(other)).toBeUndefined();
    await mongo.sessions.delete(person);
    expect(await mongo.sessions.find(person)).toBeUndefined();
  });
});

describe('settings', () => {
  it('keeps each value as JSON, per app and key', async () => {
    const appId = await addApp();
    expect(await mongo.settings.get(appId, 'sampling')).toBeUndefined();
    await mongo.settings.set(appId, 'sampling', { custom: 0.25, interaction: 1 });
    await mongo.settings.set(appId, 'sku_prices', { '700000000000000002': { amount: 499, currency: 'EUR' } });
    await mongo.settings.set(appId, 'audit_retention_days', 30);
    await mongo.settings.set(appId, 'badges', ['servers']);
    await mongo.settings.set(appId, 'badges', ['servers', 'users-monthly']);
    expect(await mongo.settings.get(appId, 'sampling')).toEqual({ custom: 0.25, interaction: 1 });
    expect(await mongo.settings.all(appId)).toEqual({
      sampling: { custom: 0.25, interaction: 1 },
      sku_prices: { '700000000000000002': { amount: 499, currency: 'EUR' } },
      audit_retention_days: 30,
      badges: ['servers', 'users-monthly'],
    });
    await mongo.settings.delete(appId, 'badges');
    expect(await mongo.settings.get(appId, 'badges')).toBeUndefined();
    expect(await mongo.settings.all(await addApp())).toEqual({});
  });

  it('accepts the time zones the server knows, every spelling, and nothing else', async () => {
    const names = [
      'Asia/Kolkata',
      'Asia/Calcutta',
      'Europe/Kyiv',
      'Etc/UTC',
      'UTC',
      'America/New_York',
      'Mars/Olympus',
      'europe/london',
      '../../etc/passwd',
      'Asia/Kolkata; DROP TABLE apps',
      '$timezone',
    ];
    const known = await Promise.all(names.map((n) => mongo.settings.supportsTimeZone(n)));
    expect(Object.fromEntries(names.map((n, i) => [n, known[i]]))).toEqual({
      'Asia/Kolkata': true,
      'Asia/Calcutta': true,
      'Europe/Kyiv': true,
      'Etc/UTC': true,
      UTC: true,
      'America/New_York': true,
      'Mars/Olympus': false,
      'europe/london': false,
      '../../etc/passwd': false,
      'Asia/Kolkata; DROP TABLE apps': false,
      $timezone: false,
    });
    for (const [i, n] of names.entries()) expect(await pg.settings.supportsTimeZone(n), n).toBe(known[i]);
  });
});

describe('admin audit', () => {
  it('records who changed what, with empty details by default', async () => {
    const appId = await addApp();
    await mongo.adminAudit.record(appId, '987654321098765432', 'login');
    await mongo.adminAudit.record(appId, null, 'settings_update', { fields: ['mode'], skipped: undefined });
    const rows = await m.c.adminAudit.find({ appId }).sort({ _id: 1 }).toArray();
    expect(rows.map(({ userId, action, details }) => ({ userId, action, details }))).toEqual([
      { userId: '987654321098765432', action: 'login', details: {} },
      { userId: undefined, action: 'settings_update', details: { fields: ['mode'] } },
    ]);
    expect(rows[1]).not.toHaveProperty('userId');
  });
});

describe('alerts', () => {
  const rule = (name: string) => ({
    name,
    metric: 'error_rate',
    comparator: '>' as const,
    threshold: 5,
    windowS: 600,
    webhook: WEBHOOK,
  });

  it('keeps rules in ID order, their history newest first, and deletes a rule with its history', async () => {
    const appId = await addApp();
    const ids: string[] = [];
    for (let i = 0; i < 11; i++) ids.push(await mongo.alerts.create(appId, rule(`rule ${i}`)));
    const listed = await mongo.alerts.list(appId);
    expect(listed.map((r) => r.id)).toEqual(ids);
    expect(listed[0]).toEqual({ ...rule('rule 0'), id: ids[0], enabled: true, lastFired: null });
    expect(await mongo.alerts.get(appId, ids[1] as string)).toEqual({ name: 'rule 1', webhook: WEBHOOK });
    expect(await mongo.alerts.get('1', ids[1] as string)).toBeUndefined();

    expect(await mongo.alerts.setEnabled(appId, ids[2] as string, false)).toBe(true);
    expect(await mongo.alerts.setEnabled('1', ids[2] as string, false)).toBe(false);
    const active = (await mongo.alerts.active()).filter((r) => r.appId === appId);
    expect(active.map((r) => r.id)).toEqual(ids.filter((_, i) => i !== 2));

    const at = (s: number) => new Date(Date.UTC(2026, 10, 25, 12, 0, s));
    await mongo.alerts.recordFiring({ id: ids[0] as string, appId }, at(1), 7.5, true, null);
    await mongo.alerts.recordFiring({ id: ids[1] as string, appId }, at(2), 9, false, 'discord returned 404');
    await mongo.alerts.recordFiring({ id: ids[0] as string, appId }, at(3), 12, true, null);
    expect(await mongo.alerts.history(appId)).toEqual([
      { ts: at(3), ruleId: ids[0], name: 'rule 0', value: 12, delivered: true, error: null },
      { ts: at(2), ruleId: ids[1], name: 'rule 1', value: 9, delivered: false, error: 'discord returned 404' },
      { ts: at(1), ruleId: ids[0], name: 'rule 0', value: 7.5, delivered: true, error: null },
    ]);
    expect((await mongo.alerts.list(appId))[0]?.lastFired).toEqual(at(3));

    expect(await mongo.alerts.delete('1', ids[0] as string)).toBe(false);
    expect(await mongo.alerts.delete(appId, ids[0] as string)).toBe(true);
    expect(await mongo.alerts.delete(appId, ids[0] as string)).toBe(false);
    expect((await mongo.alerts.history(appId)).map((f) => f.name)).toEqual(['rule 1']);
    expect(await m.c.alertEvents.countDocuments({ ruleId: ids[0] as string })).toBe(0);
  });

  it('fires through the alert job, debounces, and records a webhook it can no longer decrypt', async () => {
    const appId = await addApp();
    const settingsKey = Buffer.alloc(32, 1).toString('base64');
    const webhook = auditCipher(settingsKey).encrypt('https://discord.com/api/webhooks/112233445566778899/token');
    const id = await mongo.alerts.create(appId, { ...rule('Failures'), comparator: '>=', threshold: 0, webhook });
    await addInteractions(appId, [{ ago: 1_000, outcome: 1 }]);
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const opts = { settingsKey, dashboardUrl: undefined, fetchImpl };
    // Every app's rules are checked; only this one's are looked at here.
    await runAlerts(mongo, opts);
    await runAlerts(mongo, opts);
    expect(calls.filter((c) => c.includes('/webhooks/112233445566778899/'))).toHaveLength(1);
    const later = new Date(Date.now() + 31 * 60_000);
    await runAlerts(mongo, { ...opts, settingsKey: Buffer.alloc(32, 9).toString('base64') }, later);
    const [latest, first] = await mongo.alerts.history(appId);
    expect(latest).toMatchObject({ ts: later, ruleId: id, value: 100, delivered: false });
    expect(latest?.error).toMatch(/could not be decrypted/);
    expect(first).toMatchObject({ ruleId: id, value: 100, delivered: true, error: null });
  });

  it('shows at most the last 50 firings', async () => {
    const appId = await addApp();
    const id = await mongo.alerts.create(appId, rule('busy'));
    for (let i = 0; i < 55; i++) await mongo.alerts.recordFiring({ id, appId }, new Date(1e12 + i), i, true, null);
    const history = await mongo.alerts.history(appId);
    expect(history).toHaveLength(50);
    expect(history[0]?.value).toBe(54);
  });

  it('evaluates every metric as PostgreSQL does, over every window, with and without data', async () => {
    const empty = await addApp();
    const busy = await addApp();
    const quiet = await addApp();
    const min = 60_000;
    await addInteractions(busy, [
      { ago: 0.5 * min, outcome: 0, ackMs: 120, weight: 1 },
      { ago: 0.6 * min, outcome: 1, ackMs: 2, weight: 2 },
      { ago: 0.7 * min, outcome: 2, ackMs: 3_000, weight: 1.5 },
      { ago: 0.8 * min, outcome: 3, weight: 2.5 },
      { ago: 0.9 * min, kind: 9, outcome: 3, weight: 10 },
      { ago: 2 * min, kind: 5, outcome: 0, ackMs: 1, weight: 0.5 },
      { ago: 3 * min, kind: 8, outcome: 1, ackMs: 59_999, weight: 3 },
      { ago: 7 * min, outcome: 0, ackMs: 60_000, weight: 1 },
      { ago: 8 * min, outcome: 2, ackMs: 70_000, weight: 4 },
      { ago: 20 * min, outcome: 0, ackMs: 999, weight: 1 },
      { ago: 45 * min, kind: 9, outcome: 1, ackMs: 50, weight: 2 },
      { ago: 3 * 60 * min, outcome: 3, weight: 1 },
      { ago: 30 * 60 * min, outcome: 1, ackMs: 10, weight: 1 },
    ]);
    // No failure at all: PostgreSQL's rate is NULL, not 0 %.
    await addInteractions(quiet, [
      { ago: 0.5 * min, outcome: 0, ackMs: 80, weight: 0.5 },
      { ago: 0.6 * min, outcome: 0, weight: 0.5 },
    ]);
    for (const [appId, minutesAgo, counts] of [
      [busy, 2, [3, 4, 5]],
      [busy, 9, [100, 0, 20]],
      [busy, 15, [1_000, 1_000, 1_000]],
    ] as const) {
      const ts = new Date(Date.now() - minutesAgo * min);
      const id = uuidv7(ts.getTime());
      await db.query(
        'INSERT INTO rest_invalid (id, ts, app_id, count401, count403, count429, shared429) VALUES ($1, $2, $3, $4, $5, $6, 0)',
        [id, ts, appId, ...counts],
      );
      await m.c.restInvalid.insertOne({
        _id: new UUID(id),
        ts,
        appId,
        count401: counts[0],
        count403: counts[1],
        count429: counts[2],
        shared429: 0,
      });
    }
    await addPing(busy, 0, 0.5 * min, 40);
    await addPing(busy, 1, 5 * min, 41);
    await addPing(busy, 1, 6 * min, 42, 'b');
    await addPing(busy, 2, 2 * 60 * min, 43);
    await addPing(busy, 3, 2 * DAY, 44);
    await addPing(busy, -1, 0.5 * min, 45);
    await addAppInfo(busy, { name: 'Busy bot', sessionStartRemaining: 950 });
    await addAppInfo(quiet, { name: 'Quiet bot' });

    for (const appId of [empty, busy, quiet]) {
      for (const metric of [...ALERT_METRICS, 'no_such_metric']) {
        for (const windowS of [60, 300, 600, 3_600, 86_400]) {
          const fromPg = await pg.alerts.metricValue(appId, metric, windowS);
          const fromMongo = await mongo.alerts.metricValue(appId, metric, windowS);
          expect(fromMongo, `${metric} over ${windowS} s`).toBe(fromPg);
          // The alert job formats the value with toFixed: a numeric string from PostgreSQL stopped the run.
          expect(fromPg === null || typeof fromPg === 'number', `${metric} from PostgreSQL`).toBe(true);
          expect(fromMongo === null || typeof fromMongo === 'number').toBe(true);
        }
      }
    }
    expect(await mongo.alerts.metricValue(busy, 'error_rate', 600)).toBeGreaterThan(0);
    expect(await mongo.alerts.metricValue(quiet, 'error_rate', 600)).toBeNull();
    expect(await mongo.alerts.metricValue(busy, 'stale_shards', 600)).toBe(1);
    expect(await mongo.alerts.metricValue(busy, 'invalid_requests_pct', 60)).toBe(1.32);
  });
});

describe('a bot sampled at 30 %', () => {
  // Every event weighs 1 / 0.3, which no power of two divides: PostgreSQL adds such weights in float4, rounding at
  // every row, and after 7 of them its sum is no longer the exact sum rounded once.
  const weight = Math.fround(1 / 0.3);

  it('adds up weights as PostgreSQL adds a `real` column', async () => {
    const appId = await addApp();
    await addInteractions(
      appId,
      Array.from({ length: 7 }, (_, i) => ({ ago: (i + 1) * 60_000, command: 'roll', outcome: i % 3 ? 0 : 1, weight })),
    );
    await addCustomEvents(
      appId,
      Array.from({ length: 7 }, () => ({ name: 'spin', props: { colour: 'red' }, weight })),
    );
    const now = new Date();
    const range = { from: new Date(now.getTime() - DAY).toISOString(), to: now.toISOString() };
    const command = { kind: 'command', name: 'roll', range } as const;
    const fromPg = await pg.query.command(appId, command, now);
    expect(fromPg.totals.runs).toBe(23.33333396911621);
    expect(await mongo.query.command(appId, command, now)).toEqual(fromPg);
    const reliability = { kind: 'reliability', range } as const;
    const [pgHealth, mongoHealth] = await Promise.all([
      pg.query.reliability(appId, reliability, now),
      mongo.query.reliability(appId, reliability, now),
    ]);
    expect([mongoHealth.totals, mongoHealth.errorsByCode]).toEqual([pgHealth.totals, pgHealth.errorsByCode]);
    for (const spec of [
      { kind: 'events', range },
      { kind: 'eventProps', name: 'spin', range },
      { kind: 'eventProps', name: 'spin', range, prop: 'colour' },
    ] as const) {
      const answer = (store: Store) =>
        spec.kind === 'events' ? store.query.events(appId, spec, now) : store.query.eventProps(appId, spec, now);
      expect(await answer(mongo), spec.kind).toEqual(await answer(pg));
    }
    for (const metric of ['error_rate', 'interactions_per_min']) {
      expect(await mongo.alerts.metricValue(appId, metric, 600), metric).toBe(
        await pg.alerts.metricValue(appId, metric, 600),
      );
    }
  });
});

describe('scheduled reports', () => {
  const ZONES = [
    'America/New_York',
    'Europe/London',
    'Europe/Dublin',
    'Australia/Lord_Howe',
    'Pacific/Chatham',
    'America/Havana',
    'America/Santiago',
    'Africa/Cairo',
    'Asia/Beirut',
    'Asia/Kolkata',
  ];
  const view = (r: ReportToSend | undefined) =>
    r && {
      ...r,
      webhook: r.webhook.toString('hex'),
      dayStart: r.dayStart.toISOString(),
      weekStart: r.weekStart.toISOString(),
      dayEnd: r.dayEnd.toISOString(),
    };
  /** Hours at which the zone's offset changes in 2026. */
  const changes = (zone: string) => {
    const offset = (t: number) => wallTime(t, zone) - t;
    const out: number[] = [];
    for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 3_600_000) {
      if (offset(t) !== offset(t + 3_600_000)) out.push(t);
    }
    return out;
  };

  it('lists, counts, switches off and deletes reports in ID order', async () => {
    const appId = await addApp();
    const report = { name: 'Morning', schedule: 'daily' as const, hour: 9, weekday: 1, webhook: WEBHOOK };
    const ids = [];
    for (const store of [mongo, pg]) {
      ids.push(await store.reports.create(appId, report), await store.reports.create(appId, { ...report, name: 'B' }));
    }
    expect(ids.slice(0, 2)).toEqual(ids.slice(2));
    const [a, b] = ids as [string, string];
    for (const store of [mongo, pg]) {
      expect(await store.reports.count(appId)).toBe(2);
      expect(await store.reports.setEnabled(appId, b, false)).toBe(true);
      expect(await store.reports.setEnabled('1', b, false)).toBe(false);
      await store.reports.recordSent(a, new Date(1e12), 'discord returned 404');
      await store.reports.recordSent(a, new Date(2e12), null);
    }
    expect(await mongo.reports.list(appId)).toEqual(await pg.reports.list(appId));
    expect((await mongo.reports.list(appId))[0]).toMatchObject({ lastSent: new Date(2e12), lastError: null });
    for (const store of [mongo, pg]) {
      expect(await store.reports.delete('1', a)).toBe(false);
      expect(await store.reports.delete(appId, a)).toBe(true);
      expect(await store.reports.count(appId)).toBe(1);
      expect(await store.reports.find(appId, a, new Date())).toBeUndefined();
    }
  });

  it('records why a delivery failed and does not send again until the next local day', async () => {
    const appId = await addApp({ timezone: 'Europe/London' });
    const id = await mongo.reports.create(appId, {
      name: 'Daily',
      schedule: 'daily',
      hour: 0,
      weekday: 1,
      webhook: WEBHOOK,
    });
    await pg.reports.create(appId, { name: 'Daily', schedule: 'daily', hour: 0, weekday: 1, webhook: WEBHOOK });
    const now = new Date(Date.UTC(2026, 6, 1, 12));
    const due = async (at: Date) => (await mongo.reports.due(at)).filter((r) => r.appId === appId).map((r) => r.id);
    expect(await due(now)).toEqual([id]);
    for (const store of [mongo, pg]) await store.reports.recordSent(id, now, 'discord returned 404');
    expect(await due(now)).toEqual([]);
    expect((await mongo.reports.list(appId))[0]).toMatchObject({ lastSent: now, lastError: 'discord returned 404' });
    // London's day starts at 23:00 UTC in summer.
    expect(await due(new Date(Date.UTC(2026, 6, 1, 22, 59)))).toEqual([]);
    expect(await due(new Date(Date.UTC(2026, 6, 1, 23, 0)))).toEqual([id]);
  });

  it(
    'works out due reports and their periods as PostgreSQL does, across every DST change',
    { timeout: 180_000 },
    async () => {
      // Zones that skip or repeat local midnight (Havana, Santiago, Cairo, Beirut), shift by half an hour (Lord Howe),
      // sit 45 minutes off (Chatham), have "negative" DST in the tz database (Dublin), or none (Kolkata).
      const apps: { appId: string; zone: string; reports: string[]; changes: number[] }[] = [];
      for (const [i, zone] of ZONES.entries()) {
        const appId = await addApp({ timezone: zone, ...(i % 3 === 0 && { name: `Bot ${i}` }) });
        if (i % 3 === 1) await addAppInfo(appId, { name: `Reported ${i}` });
        const reports: string[] = [];
        for (const r of [
          { schedule: 'daily', hour: 0, weekday: 1 },
          { schedule: 'daily', hour: 1, weekday: 1 },
          { schedule: 'daily', hour: 23, weekday: 1 },
          { schedule: 'weekly', hour: 0, weekday: 7 },
          { schedule: 'weekly', hour: 3, weekday: 1 },
        ] as const) {
          const report = { name: `${zone} ${r.schedule} ${r.hour}`, ...r, webhook: WEBHOOK };
          const id = await mongo.reports.create(appId, report);
          expect(await pg.reports.create(appId, report)).toBe(id);
          reports.push(id);
        }
        apps.push({ appId, zone, reports, changes: changes(zone) });
      }
      // Sent at a change, and a millisecond before one: due again only once the local day after has begun.
      for (const app of apps) {
        const change = app.changes[0] ?? Date.UTC(2026, 5, 1);
        for (const store of [mongo, pg]) {
          await store.reports.recordSent(app.reports[1] as string, new Date(change), null);
          await store.reports.recordSent(app.reports[2] as string, new Date(change - 1), null);
        }
      }

      // This runtime and PostgreSQL each carry a release of the tz database, and the releases can differ (Node 24's
      // 2026e and PostgreSQL 16.16's disagree about Havana from November 2026). Only the rules are compared here: an
      // report whose period could touch an hour where the two disagree is left out of the comparison at that instant.
      const disagree = new Map<string, number[]>();
      for (const zone of ZONES) {
        const offsets = await db.query<{ ts: Date; off: number }>(
          `SELECT ts, extract(epoch FROM (ts AT TIME ZONE $1) - (ts AT TIME ZONE 'UTC'))::int AS off
           FROM generate_series('2025-12-20Z'::timestamptz, '2027-01-02Z', '1 hour') AS ts`,
          [zone],
        );
        disagree.set(
          zone,
          offsets.rows
            .filter(({ ts, off }) => (wallTime(ts.getTime(), zone) - ts.getTime()) / 1000 !== off)
            .map(({ ts }) => ts.getTime()),
        );
      }
      const comparable = (zone: string, t: number) =>
        !disagree.get(zone)?.some((h) => h > t - 9 * DAY && h < t + 2 * DAY);
      let skipped = 0;

      const instants = new Set<number>();
      for (const app of apps) {
        for (const change of app.changes) {
          for (let t = change - 36 * 3_600_000; t <= change + 36 * 3_600_000; t += 37 * 60_000) instants.add(t);
        }
      }
      for (let t = Date.UTC(2026, 0, 3, 5, 17); t < Date.UTC(2027, 0, 1); t += 7.3 * DAY) instants.add(t);
      let compared = 0;
      for (const t of [...instants].sort((a, b) => a - b)) {
        const now = new Date(t);
        const shown = (due: ReportToSend[]) => due.filter((r) => comparable(r.timezone, t)).map(view);
        const [fromMongo, fromPg] = await Promise.all([mongo.reports.due(now), pg.reports.due(now)]);
        expect(shown(fromMongo), now.toISOString()).toEqual(shown(fromPg));
        if (compared++ % 7 === 0) {
          for (const app of apps) {
            if (!comparable(app.zone, t)) {
              skipped++;
              continue;
            }
            const id = app.reports[compared % 5] as string;
            const [a, b] = await Promise.all([
              mongo.reports.find(app.appId, id, now),
              pg.reports.find(app.appId, id, now),
            ]);
            expect(view(a), `${app.zone} at ${now.toISOString()}`).toEqual(view(b));
          }
        }
      }
      expect(compared).toBeGreaterThan(1_500);
      expect(skipped).toBeLessThan(100);
    },
  );
});

describe('privacy', () => {
  const lookup = (n: number) => Buffer.alloc(32, n);
  const hex = (b: Buffer | null) => b?.toString('hex') ?? null;

  /** The same audit log rows in both stores. Rows 10 to 13 share one millisecond. */
  async function addActivity(appId: string, base: number) {
    const ids: string[] = [];
    for (let i = 0; i < 24; i++) {
      const ts = base + (i >= 10 && i <= 13 ? 10 : i) * 60_000;
      const id = uuidv7(ts);
      ids.push(id);
      const outcome = (i * 3) % 4;
      const row = {
        id,
        ts: new Date(ts),
        lookup: lookup(1 + (i % 3)),
        actor: Buffer.from(`actor ${i}`),
        names: i % 4 === 0 ? null : Buffer.from(`names ${i}`),
        guild: [null, '500000000000000001', '500000000000000002', '500000000000000003'][i % 4] ?? null,
        kind: [1, 5, 9][i % 3] as number,
        command: ['ticket', null, 'ban'][i % 3] ?? null,
        sub: i % 2 ? 'open' : null,
        customId: i % 3 === 1 ? `button:${i}` : null,
        outcome,
        ackMs: outcome === 3 ? null : 100 + i,
      };
      await db.query(
        `INSERT INTO audit_log (interaction_id, ts, app_id, actor_lookup, actor_enc, names_enc, guild_id, kind, command, sub,
                                custom_id, outcome, ack_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          row.id,
          row.ts,
          appId,
          row.lookup,
          row.actor,
          row.names,
          row.guild,
          row.kind,
          row.command,
          row.sub,
          row.customId,
          row.outcome,
          row.ackMs,
        ],
      );
      await m.c.auditLog.insertOne({
        _id: new UUID(row.id),
        ts: row.ts,
        appId,
        actorLookup: new Binary(row.lookup),
        actorEnc: new Binary(row.actor),
        ...(row.names && { namesEnc: new Binary(row.names) }),
        ...(row.guild && { guildId: row.guild }),
        kind: row.kind,
        ...(row.command && { command: row.command }),
        ...(row.sub && { sub: row.sub }),
        ...(row.customId && { customId: row.customId }),
        outcome: row.outcome,
        ...(row.ackMs !== null && { ackMs: row.ackMs }),
      });
    }
    return ids;
  }

  const shown = (rows: Awaited<ReturnType<Store['privacy']['activity']>>) =>
    rows.map((r) => ({ ...r, ts: r.ts.toISOString(), userId: hex(r.userId), profile: hex(r.profile) }));

  let auditApp: string;
  let base: number;
  let ids: string[];

  beforeAll(async () => {
    auditApp = await addApp();
    base = Math.floor(Date.now() / 1000) * 1000 - 3_600_000;
    ids = await addActivity(auditApp, base);
    await addGuild(auditApp, '500000000000000001', { name: 'Guild One' });
    await addGuild(auditApp, '500000000000000003', { name: '' });
    // Older runs of one user: in the last 7 days, not the last 24 hours.
    for (let i = 0; i < 5; i++) {
      const ts = new Date(Date.now() - 2 * DAY - i * 60_000);
      const id = uuidv7(ts.getTime());
      await db.query(
        `INSERT INTO audit_log (interaction_id, ts, app_id, actor_lookup, actor_enc, kind, outcome)
         VALUES ($1, $2, $3, $4, $5, 1, 0)`,
        [id, ts, auditApp, lookup(3), Buffer.from(`old ${i}`)],
      );
      await m.c.auditLog.insertOne({
        _id: new UUID(id),
        ts,
        appId: auditApp,
        actorLookup: new Binary(lookup(3)),
        actorEnc: new Binary(Buffer.from(`old ${i}`)),
        kind: 1,
        outcome: 0,
      });
    }
  });

  it('reads the activity log as PostgreSQL does, with every filter', async () => {
    const at = (i: number) => new Date(base + i * 60_000).toISOString();
    // A time between two stored milliseconds, and one with an offset.
    const between = (i: number) => at(i).replace('Z', '400Z');
    const shifted = (i: number) => new Date(base + i * 60_000 + 3_600_000).toISOString().replace('Z', '+01:00');
    const filters = [
      {},
      { command: 'ticket' },
      { guild: '500000000000000001' },
      { guild: '500000000000000002' },
      { actorLookup: lookup(2) },
      { outcome: 'ok' as const },
      { outcome: 'error' as const },
      { outcome: 'timeout' as const },
      { outcome: 'no_response' as const },
      { outcome: 'failed' as const },
      { outcome: 'failed' as const, guild: '500000000000000003' },
      { from: at(5), to: at(15) },
      { from: shifted(5) },
      { from: between(10) },
      { to: between(10) },
      { to: at(10) },
      { before: { ts: at(12) } },
      { before: { ts: between(10) } },
      { before: { ts: shifted(10) } },
      { before: { ts: at(10), id: ids[11] } },
      { before: { ts: at(10), id: (ids[12] as string).toUpperCase() } },
      {
        before: {
          ts: at(10),
          id: (ids[12] as string)
            .replaceAll('-', '')
            .replace(/(.{4})/g, '$1-')
            .slice(0, 39),
        },
      },
      { before: { ts: between(10), id: ids[11] } },
      { before: { ts: at(10).replace(/\.\d+Z$/, '.000000Z'), id: ids[11] } },
      { command: 'ban', outcome: 'failed' as const, actorLookup: lookup(3) },
      { from: at(30) },
    ];
    for (const filter of filters) {
      for (const limit of [1, 2, 5, 50]) {
        const [a, b] = await Promise.all([
          mongo.privacy.activity(auditApp, filter, limit),
          pg.privacy.activity(auditApp, filter, limit),
        ]);
        expect(shown(a), `${JSON.stringify(filter)} limit ${limit}`).toEqual(shown(b));
      }
    }
    expect((await mongo.privacy.activity(auditApp, { guild: '500000000000000001' }, 50))[0]?.guildName).toBe(
      'Guild One',
    );
  });

  it('pages through rows of the same millisecond without skipping or repeating one, as PostgreSQL does', async () => {
    const walk = async (store: Store, filter: { outcome?: 'failed' }) => {
      const pages: string[][] = [];
      let before: { ts: string; id: string } | undefined;
      for (;;) {
        const rows = await store.privacy.activity(auditApp, { ...filter, ...(before && { before }) }, 3);
        pages.push(rows.map((r) => r.interactionId));
        const last = rows.at(-1);
        if (rows.length < 3 || !last) return pages;
        before = { ts: last.ts.toISOString(), id: last.interactionId };
      }
    };
    for (const filter of [{}, { outcome: 'failed' as const }]) {
      const pages = await walk(mongo, filter);
      expect(pages).toEqual(await walk(pg, filter));
      expect(new Set(pages.flat()).size).toBe(pages.flat().length);
    }
    expect((await walk(mongo, {})).flat()).toHaveLength(29);
  });

  it('refuses a paging position PostgreSQL could not read, as a bad request', async () => {
    for (const before of [
      { ts: new Date(base).toISOString(), id: '------------------------------------' },
      { ts: '2026-13-45T99:99:99Z', id: ids[0] as string },
      { ts: '2026-02-30T10:00:00Z' },
    ]) {
      await expect(pg.privacy.activity(auditApp, { before }, 5)).rejects.toBeDefined();
      await expect(mongo.privacy.activity(auditApp, { before }, 5)).rejects.toMatchObject({
        statusCode: 400,
        code: 'invalid_request',
      });
    }
  });

  it('reads a page in index order, and the newest failures from the indexes that hold only failures', async () => {
    const appId = await addApp();
    const guildId = '500000000000000009';
    const now = Date.now();
    await m.c.auditLog.insertMany(
      Array.from({ length: 600 }, (_, i) => ({
        _id: new UUID(uuidv7(now - i * 1_000)),
        ts: new Date(now - i * 1_000),
        appId,
        actorLookup: new Binary(lookup(1)),
        actorEnc: new Binary(Buffer.from('actor')),
        guildId,
        kind: 1,
        outcome: i % 60 === 0 ? 2 : 0,
      })),
    );
    const plan = async (filter: object) => {
      const explained = await m.c.auditLog
        .find({ appId, ...filter })
        .sort({ ts: -1, _id: -1 })
        .limit(50)
        .explain('executionStats');
      return JSON.stringify(explained.queryPlanner.winningPlan);
    };
    const filters = await Promise.all([
      plan({}),
      plan({ outcome: { $gt: 0 } }),
      plan({ guildId, outcome: { $gt: 0, $eq: 2 } }),
    ]);
    for (const winning of filters) expect(winning).not.toContain('SORT');
    expect(filters[1]).toContain('failed_appId_ts_id');
    expect(filters[2]).toContain('failed_appId_guildId_ts_id');
  });

  it('ranks the users with the most runs in each window, with their latest encrypted ID', async () => {
    for (const window of ['24h', '7d'] as const) {
      const byLookup = (rows: { userId: Buffer; runs: number }[]) =>
        rows
          .map((r) => ({ userId: hex(r.userId), runs: r.runs }))
          .sort((a, b) => b.runs - a.runs || (a.userId ?? '').localeCompare(b.userId ?? ''));
      const fromMongo = await mongo.privacy.topActors(auditApp, window);
      expect(byLookup(fromMongo)).toEqual(byLookup(await pg.privacy.topActors(auditApp, window)));
      expect(fromMongo.map((r) => r.runs)).toEqual([...fromMongo.map((r) => r.runs)].sort((a, b) => b - a));
    }
    expect((await mongo.privacy.topActors(auditApp, '7d'))[0]).toEqual({ userId: Buffer.from('actor 23'), runs: 13 });
  });

  it("erases a user's salted hash from every collection PostgreSQL erases it from, and nothing else", async () => {
    const appId = await addApp();
    const otherApp = await addApp();
    const [gone, kept] = [Buffer.alloc(16, 7), Buffer.alloc(16, 8)];
    await addInteractions(appId, [
      { ago: 60_000, userHash: gone },
      { ago: 120_000, userHash: gone },
      { ago: 1, userHash: kept },
    ]);
    await addInteractions(otherApp, [{ ago: 60_000, userHash: gone }]);
    await db.query("CREATE TABLE IF NOT EXISTS uniques_erase_test PARTITION OF uniques FOR VALUES IN ('erase-test')");
    const ts = new Date(Date.now() - 60_000);
    for (const [hash, scope] of [
      [gone, 'global'],
      [gone, 'command'],
      [kept, 'global'],
    ] as const) {
      await db.query(
        "INSERT INTO uniques (app_id, period, day, scope, scope_key, user_hash) VALUES ($1, 'erase-test', '2026-11-25', $2, '*', $3)",
        [appId, scope, hash],
      );
      await m.c.uniques.insertOne({
        _id: { appId, period: 'erase-test', scope, scopeKey: '*', day: '2026-11-25', userHash: new Binary(hash) },
      });
    }
    for (const hash of [gone, null]) {
      const id = uuidv7(ts.getTime());
      await db.query(
        "INSERT INTO custom_events (id, ts, app_id, name, props, user_hash, weight) VALUES ($1, $2, $3, 'vote', '{}', $4, 1)",
        [id, ts, appId, hash],
      );
      await m.c.customEvents.insertOne({
        _id: new UUID(id),
        ts,
        appId,
        name: 'vote',
        props: {},
        ...(hash && { userHash: new Binary(hash) }),
        weight: 1,
      });
    }
    await db.query(
      `INSERT INTO entitlements (app_id, ts, action, sku_id, entitlement_type, owner, user_hash, source)
       VALUES ($1, $2, 'create', 700000000000000002, 8, 'user', $3, 'gateway')`,
      [appId, ts, gone],
    );
    await m.c.entitlements.insertOne({
      _id: new Binary(randomBytes(32)),
      appId,
      ts,
      action: 'create',
      skuId: '700000000000000002',
      entitlementType: 8,
      owner: 'user',
      userHash: new Binary(gone),
      source: 'gateway',
    });
    const subscription = uuidv7(ts.getTime());
    await db.query(
      `INSERT INTO subscriptions (id, ts, app_id, action, status, sku_ids, user_hash, period_start, period_end)
       VALUES ($1, $2, $3, 'create', 0, '{700000000000000002}', $4, $2, $2)`,
      [subscription, ts, appId, gone],
    );
    await m.c.subscriptions.insertOne({
      _id: new UUID(subscription),
      ts,
      appId,
      action: 'create',
      status: 0,
      skuIds: ['700000000000000002'],
      userHash: new Binary(gone),
      periodStart: ts,
      periodEnd: ts,
    });
    const installs: string[] = [];
    for (const hash of [gone, kept]) {
      const id = uuidv7(ts.getTime());
      installs.push(id);
      const actor = Buffer.from(`installer ${hash.toString('hex')}`);
      await db.query(
        `INSERT INTO webhook_events (id, ts, app_id, type, integration_type, user_hash, actor_enc)
         VALUES ($1, $2, $3, 'APPLICATION_AUTHORIZED', 1, $4, $5)`,
        [id, ts, appId, hash, actor],
      );
      await m.c.webhookEvents.insertOne({
        _id: new UUID(id),
        ts,
        appId,
        type: 'APPLICATION_AUTHORIZED',
        integrationType: 1,
        userHash: new Binary(hash),
        actorEnc: new Binary(actor),
      });
    }

    const installers = async (store: Store) =>
      (await store.privacy.installers(appId))
        .map((w) => ({ id: w.id, ts: w.ts.toISOString(), actor: hex(w.actor) }))
        .sort((a, b) => a.id.localeCompare(b.id));
    expect(await installers(mongo)).toEqual(await installers(pg));
    expect(await installers(mongo)).toHaveLength(2);

    const erased = await mongo.privacy.eraseHashes(appId, [gone, Buffer.alloc(16, 9)]);
    expect(erased).toBe(await pg.privacy.eraseHashes(appId, [gone, Buffer.alloc(16, 9)]));
    expect(erased).toBe(8);
    const hashOf = { userHash: new Binary(gone) };
    for (const left of [
      m.c.interactions.countDocuments({ appId, ...hashOf }),
      m.c.customEvents.countDocuments({ appId, ...hashOf }),
      m.c.uniques.countDocuments({ '_id.appId': appId, '_id.userHash': new Binary(gone) }),
      m.c.entitlements.countDocuments({ appId }),
      m.c.subscriptions.countDocuments({ appId }),
      m.c.webhookEvents.countDocuments({ appId, ...hashOf }),
    ]) {
      expect(await left).toBe(0);
    }
    expect(await m.c.interactions.countDocuments({ appId: otherApp })).toBe(1);
    expect(await m.c.interactions.countDocuments({ appId })).toBe(1);
    expect(await m.c.uniques.countDocuments({ '_id.appId': appId })).toBe(1);
    expect(await m.c.customEvents.countDocuments({ appId })).toBe(1);

    const [left] = await installers(mongo);
    for (const store of [mongo, pg]) await store.privacy.forgetInstaller(installs[1] as string, ts);
    expect(left?.id).toBe(installs[1]);
    expect(await installers(mongo)).toEqual([]);
    expect(await installers(pg)).toEqual([]);
    expect(await m.c.webhookEvents.countDocuments({ appId })).toBe(1);
  });

  it("erases one user's activity log and nobody else's", async () => {
    const erased = await mongo.privacy.eraseActivity(auditApp, lookup(2));
    expect(erased).toBe(await pg.privacy.eraseActivity(auditApp, lookup(2)));
    expect(erased).toBe(8);
    expect(await mongo.privacy.activity(auditApp, { actorLookup: lookup(2) }, 50)).toEqual([]);
    expect(await m.c.auditLog.countDocuments({ appId: auditApp })).toBe(21);
  });

  it('logs reads of audit data, newest first, under the key or person that read', async () => {
    const appId = await addApp();
    const entries = [];
    for (const store of [mongo, pg]) {
      const keyId = await store.keys.create({
        appId,
        scope: 'activity',
        sha256: randomBytes(32),
        label: 'my dashboard',
      });
      for (let i = 0; i < 3; i++) {
        await store.privacy.logAccess({
          appId,
          viewerUserId: i === 1 ? '987654321098765432' : '0',
          viewerKeyId: i === 1 ? null : keyId,
          action: ['view_log', 'lookup_user', 'top_users'][i] as string,
          details: { rows: i, user: undefined },
        });
      }
      entries.push((await store.privacy.accessLog(appId)).map(({ ts: _ts, ...rest }) => rest));
    }
    expect(entries[0]).toEqual(entries[1]);
    expect(entries[0]).toEqual([
      { viewerUserId: '0', viewerKey: 'my dashboard', action: 'top_users', details: { rows: 2 } },
      { viewerUserId: '987654321098765432', viewerKey: null, action: 'lookup_user', details: { rows: 1 } },
      { viewerUserId: '0', viewerKey: 'my dashboard', action: 'view_log', details: { rows: 0 } },
    ]);
  });
});

describe('live tiles', () => {
  it('reads p95, shard pings and servers as PostgreSQL does', async () => {
    const empty = await addApp();
    const appId = await addApp();
    const min = 60_000;
    await addInteractions(appId, [
      { ago: 0.2 * min, ackMs: 120, weight: 1 },
      { ago: 0.3 * min, ackMs: 3_000, weight: 2.5 },
      { ago: 0.4 * min, ackMs: 160, weight: 0.5 },
      { ago: 1 * min, ackMs: 45_000, weight: 1.5 },
      { ago: 2 * min, outcome: 3 },
      { ago: 4 * min, ackMs: 9, weight: 3 },
      { ago: 6 * min, ackMs: 59_000, weight: 50 },
    ]);
    await addPing(appId, 0, 0.5 * min, 41.5);
    await addPing(appId, 0, 1.5 * min, 99);
    await addPing(appId, 1, 3 * min, 52);
    await addPing(appId, 2, 50 * min, 63);
    await addPing(appId, 3, 70 * min, 74);
    await addPing(appId, -1, 0.1 * min, 5);
    await addGuild(appId, '600000000000000001');
    await addGuild(appId, '600000000000000002');
    await addGuild(appId, '600000000000000003', { left: true });
    for (const id of [empty, appId]) expect(await mongo.live.recent(id)).toEqual(await pg.live.recent(id));
    expect(await mongo.live.recent(appId)).toEqual({
      // Weights round half to even: 3 at 9 ms, 1 at 120, 0 at 160, 2 at 3 s and 2 at 45 s.
      p95Ms5m: POSTGRES_BUCKET_UPPER_MS[bucketOf(45_000)],
      shards: [
        { shard: -1, ping: 5, fresh: true },
        { shard: 0, ping: 41.5, fresh: true },
        { shard: 1, ping: 52, fresh: false },
        { shard: 2, ping: 63, fresh: false },
      ],
      servers: 2,
    });
  });

  const until = async (check: () => boolean | Promise<boolean>, ms = 15_000) => {
    const end = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const second = () => Math.floor(Date.now() / 1000);

  it('hands counts to an instance with a stream open, once each, and never an instance its own', async () => {
    await m.c.liveShares.deleteMany({});
    const publisher = mongo.live.channel();
    const watcher = mongo.live.channel();
    const got: LiveShare[] = [];
    const own: LiveShare[] = [];
    expect(
      await publisher.subscribe(
        (s) => own.push(s),
        () => undefined,
      ),
    ).toBe(true);
    expect(
      await watcher.subscribe(
        (s) => got.push(s),
        () => undefined,
      ),
    ).toBe(true);
    try {
      // Nobody watches: an instance with traffic keeps it to itself, and one with none writes nothing.
      const early = second() - 60;
      await publisher.publish({ instance: 'p', appId: '1', counts: [[second(), 0, 0]] });
      await publisher.publish({ instance: 'p', appId: '1', counts: [[early, 4, 1]] });
      expect(await m.c.liveShares.countDocuments()).toBe(0);

      watcher.listen?.(true);
      publisher.listen?.(true);
      await until(async () => (await m.c.liveListeners.countDocuments()) === 2);
      // The held counts go out at the next check, within 10 seconds.
      await until(() => got.length > 0);
      const s = second();
      await publisher.publish({ instance: 'p', appId: '1', counts: [[s, 2, 0]] });
      await publisher.publish({ instance: 'p', appId: '2', counts: [[s, 1, 1]] });
      await until(() => got.flatMap((g) => g.counts).length >= 3);
      await new Promise((r) => setTimeout(r, 2_500));
      expect(got.flatMap((g) => g.counts.map((c) => [g.appId, ...c])).sort()).toEqual(
        [
          ['1', early, 4, 1],
          ['1', s, 2, 0],
          ['2', s, 1, 1],
        ].sort(),
      );
      expect(got.every((g) => g.instance === 'p')).toBe(true);
      expect(own).toEqual([]);
    } finally {
      await publisher.stop();
      await watcher.stop();
    }
    expect(await m.c.liveListeners.countDocuments()).toBe(0);
  }, 60_000);

  it('sends a share again under its first time when the reply to its write was lost', async () => {
    await m.c.liveShares.deleteMany({});
    const shares = m.c.liveShares;
    let lose = true;
    const lossy = {
      updateOne: async (...args: Parameters<typeof shares.updateOne>) => {
        const written = await shares.updateOne(...args);
        if (!lose) return written;
        lose = false;
        throw new Error('connection reset');
      },
    } as unknown as Collection<LiveShareDoc>;
    const watcher = mongo.live.channel();
    const publisher = liveWith({ liveShares: lossy }).channel();
    const got: LiveShare[] = [];
    await watcher.subscribe(
      (s) => got.push(s),
      () => undefined,
    );
    await publisher.subscribe(
      () => undefined,
      () => undefined,
    );
    try {
      watcher.listen?.(true);
      await until(async () => (await m.c.liveListeners.countDocuments()) === 1);
      const s = second();
      await expect(publisher.publish({ instance: 'p', appId: '1', counts: [[s, 3, 1]] })).rejects.toThrow();
      const [first] = await m.c.liveShares.find().toArray();
      if (!first) throw new Error('the write whose reply was lost was not stored');
      await new Promise((r) => setTimeout(r, 1_100));
      await publisher.publish({ instance: 'p', appId: '1', counts: [[s + 1, 2, 0]] });
      // Stamped again, the first share would come back to a watcher once it no longer remembers its ID.
      expect((await m.c.liveShares.findOne({ _id: first._id }))?.at).toEqual(first.at);
      await until(() => got.length === 2);
      expect(got.flatMap((g) => g.counts).sort((a, b) => a[0] - b[0])).toEqual([
        [s, 3, 1],
        [s + 1, 2, 0],
      ]);
    } finally {
      await publisher.stop();
      await watcher.stop();
    }
  });

  it('reads back the last 15 minutes when a stream opens, and nothing older', async () => {
    await m.c.liveShares.deleteMany({});
    const s = second();
    await m.c.liveShares.insertMany([
      { _id: 'recent', instance: 'q', appId: '1', counts: [[s - 100, 3, 0]], at: new Date(Date.now() - 100_000) },
      { _id: 'old', instance: 'q', appId: '1', counts: [[s - 1_000, 9, 9]], at: new Date(Date.now() - 1_000_000) },
      {
        _id: 'mixed',
        instance: 'q',
        appId: '1',
        counts: [
          [s - 950, 7, 7],
          [s - 10, 1, 0],
        ],
        at: new Date(),
      },
    ]);
    const watcher = mongo.live.channel();
    const got: LiveShare[] = [];
    await watcher.subscribe(
      (share) => got.push(share),
      () => undefined,
    );
    try {
      watcher.listen?.(true);
      await until(() => got.length === 2);
      expect(got.flatMap((g) => g.counts).sort((a, b) => a[0] - b[0])).toEqual([
        [s - 100, 3, 0],
        [s - 10, 1, 0],
      ]);
    } finally {
      await watcher.stop();
    }
  });

  it('polls only while a stream is open', async () => {
    let reads = 0;
    const shares = m.c.liveShares;
    const counted = {
      find: (...args: Parameters<typeof shares.find>) => {
        reads++;
        return shares.find(...args);
      },
    } as unknown as Collection<LiveShareDoc>;
    const watcher = liveWith({ liveShares: counted }).channel();
    await watcher.subscribe(
      () => undefined,
      () => undefined,
    );
    try {
      await new Promise((r) => setTimeout(r, 1_500));
      expect(reads).toBe(0);
      watcher.listen?.(true);
      await until(() => reads >= 2);
      // A reload: closed and opened again at once, the polling goes on.
      watcher.listen?.(false);
      watcher.listen?.(true);
      const before = reads;
      await until(() => reads > before);
    } finally {
      await watcher.stop();
    }
    const stopped = reads;
    await new Promise((r) => setTimeout(r, 1_500));
    expect(reads).toBe(stopped);
  });

  it('says it could not subscribe when the server is unreachable, and warns once per outage', async () => {
    const client = new MongoClient('mongodb://127.0.0.1:9/x', { serverSelectionTimeoutMS: 300 });
    const lonely = mongoLive({ client, db: client.db('x'), c: collections(client.db('x')) }).channel();
    expect(
      await lonely.subscribe(
        () => undefined,
        () => undefined,
      ),
    ).toBe(false);
    await lonely.stop();
    await client.close();

    let failing = false;
    const shares = m.c.liveShares;
    const flaky = {
      find: (...args: Parameters<typeof shares.find>) => {
        if (failing) throw new Error('unreachable');
        return shares.find(...args);
      },
    } as unknown as Collection<LiveShareDoc>;
    const warnings: string[] = [];
    const watcher = liveWith({ liveShares: flaky }).channel();
    expect(
      await watcher.subscribe(
        () => undefined,
        (w) => warnings.push(w),
      ),
    ).toBe(true);
    try {
      watcher.listen?.(true);
      failing = true;
      await new Promise((r) => setTimeout(r, 3_500));
      expect(warnings).toHaveLength(1);
      failing = false;
      await new Promise((r) => setTimeout(r, 4_500));
      failing = true;
      await until(() => warnings.length === 2, 10_000);
    } finally {
      await watcher.stop();
    }
  }, 60_000);
});

/** The live storage on this database, a collection swapped for a test double. */
function liveWith(swap: { liveShares: Collection<LiveShareDoc> }) {
  return mongoLive({ ...m, c: { ...m.c, ...swap } });
}

describe('job leader', () => {
  const fast = { leaseMs: 1_500, renewMs: 300, marginMs: 300 };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  /** This database's leases, with renewals that fail or never answer when told to. */
  const flakyLeases = () => {
    const leases = m.c.leases;
    const state = { mode: 'ok' as 'ok' | 'fail' | 'hang' };
    const flaky = {
      findOneAndUpdate: (...args: Parameters<typeof leases.findOneAndUpdate>) => {
        if (state.mode === 'fail') return Promise.reject(new Error('unreachable'));
        if (state.mode === 'hang') return new Promise(() => undefined);
        return leases.findOneAndUpdate(...args);
      },
      deleteOne: (...args: Parameters<typeof leases.deleteOne>) => leases.deleteOne(...args),
    } as unknown as typeof leases;
    return { state, mongo: { ...m, c: { ...m.c, leases: flaky } } };
  };

  it('lets one contender lead at a time, renews its lease, and hands over on release', async () => {
    await m.c.leases.deleteMany({});
    const contenders = Array.from({ length: 5 }, () => mongoLeader(m, fast));
    const lost: number[] = [];
    // Connections open first: on a busy machine, a contender still connecting when the first's 1.5-second lease runs
    // out takes it fairly (the first has stopped leading by then), which is not what this race is about.
    await Promise.all(contenders.map(() => m.db.command({ ping: 1 })));
    const won = await Promise.all(contenders.map((c, i) => c.tryLead(() => lost.push(i))));
    expect(won.filter(Boolean)).toHaveLength(1);
    const leader = won.indexOf(true);
    const [first, second] = [contenders[leader], contenders[(leader + 1) % 5]] as const;
    // Kept past the lease's length by renewals.
    await sleep(2_500);
    expect(await second?.tryLead(() => lost.push(-1))).toBe(false);
    expect(lost).toEqual([]);
    await first?.release();
    expect(await first?.tryLead(() => undefined)).toBe(false);
    expect(await second?.tryLead(() => undefined)).toBe(true);
    for (const c of contenders) await c.release();
    expect(lost).toEqual([]);
  });

  it('says once that leadership is lost when the lease is taken, and does not take it back', async () => {
    await m.c.leases.deleteMany({});
    const leader = mongoLeader(m, fast);
    let lost = 0;
    expect(await leader.tryLead(() => lost++)).toBe(true);
    await m.c.leases.updateOne({ _id: 'jobs' }, { $set: { holder: 'someone else' } });
    await sleep(1_000);
    expect(lost).toBe(1);
    expect(await leader.tryLead(() => lost++)).toBe(false);
    await leader.release();
    expect(await m.c.leases.countDocuments({ holder: 'someone else' })).toBe(1);
  });

  it('stops leading at once when a renewal fails, and another leads only once the lease has run out', async () => {
    await m.c.leases.deleteMany({});
    const { state, mongo: failing } = flakyLeases();
    const leader = mongoLeader(failing, fast);
    const next = mongoLeader(m, fast);
    let lost = 0;
    expect(await leader.tryLead(() => lost++)).toBe(true);
    state.mode = 'fail';
    await sleep(600);
    expect(lost).toBe(1);
    const leaseEnds = (await m.c.leases.findOne({ _id: 'jobs' }))?.expiresAt.getTime() as number;
    expect(await next.tryLead(() => undefined)).toBe(false);
    await sleep(Math.max(0, leaseEnds - Date.now()) + 100);
    expect(await next.tryLead(() => undefined)).toBe(true);
    await next.release();
    await sleep(500);
    expect(lost).toBe(1);
  });

  it('stops leading before the lease runs out when a renewal never answers', async () => {
    await m.c.leases.deleteMany({});
    const { state, mongo: hanging } = flakyLeases();
    const leader = mongoLeader(hanging, fast);
    let lostAt: number | undefined;
    expect(await leader.tryLead(() => (lostAt ??= Date.now()))).toBe(true);
    state.mode = 'hang';
    // The renewal sent now hangs; the last one that answered was the take, so the lease ends 1.5 s after it.
    const leaseEnds = (await m.c.leases.findOne({ _id: 'jobs' }))?.expiresAt.getTime() as number;
    await sleep(Math.max(0, leaseEnds - Date.now()) + 100);
    expect(lostAt).toBeDefined();
    expect(lostAt as number).toBeLessThan(leaseEnds);
    expect(await mongoLeader(m, fast).tryLead(() => undefined)).toBe(true);
    await leader.release();
  });
});
