import { generateKeyPairSync, sign } from 'node:crypto';
import { uuidv7 } from '@shardlens/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAlerts } from '../src/jobs/alerts.js';
import { runReports } from '../src/jobs/reports.js';
import { ALERT_METRICS } from '../src/routes/admin.js';
import { seedKey } from '../src/security/auth.js';
import { auditCipher } from '../src/security/crypto.js';
import {
  APP_ID,
  envelope,
  type Harness,
  INGEST_KEY,
  ingest,
  interaction,
  onPostgres,
  query,
  READ_KEY,
  sdkHasher,
  startHarness,
  testSession,
} from './harness.js';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const PUBLIC_KEY_HEX = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url').toString('hex');
const AUDIT_KEY = Buffer.alloc(32, 9).toString('base64');
const ADMIN = '987654321098765432';
/** Signed in once, but on no team list any more. */
const FORMER_ADMIN = '876543210987654321';
const USER = '555555555555555555';
const WEBHOOK = 'https://discord.com/api/webhooks/112233445566778899/abcDEF_token';

let h: Harness;
let adminCookie: string;
let readCookie: string;

const asAdmin = (extra: Record<string, string> = {}) => ({
  cookies: { shardlens_session: adminCookie },
  headers: { 'x-shardlens-csrf': '1', ...extra },
});

function signed(body: object, ts = Math.floor(Date.now() / 1000)) {
  const raw = Buffer.from(JSON.stringify(body));
  const signature = sign(null, Buffer.concat([Buffer.from(String(ts)), raw]), privateKey).toString('hex');
  return {
    method: 'POST' as const,
    url: '/v1/discord/events',
    headers: {
      'content-type': 'application/json',
      'x-signature-ed25519': signature,
      'x-signature-timestamp': String(ts),
    },
    payload: raw,
  };
}

const settle = () => new Promise((r) => setTimeout(r, 150));

beforeAll(async () => {
  h = await startHarness({ discordPublicKey: PUBLIC_KEY_HEX, auditKey: AUDIT_KEY, extraAdmins: [ADMIN] });
  adminCookie = await testSession(h.store, 'discord', ADMIN);
  readCookie = await testSession(h.store, 'read_key', null);
});

afterAll(async () => {
  await h?.close();
});

describe('Discord webhook events', () => {
  const authorized = (userId: string) => ({
    version: 1,
    application_id: APP_ID,
    type: 1,
    event: {
      type: 'APPLICATION_AUTHORIZED',
      timestamp: new Date().toISOString(),
      data: { integration_type: 1, scopes: ['applications.commands'], user: { id: userId, username: 'someone' } },
    },
  });

  it('answers PING with 204 and refuses bad, stale or missing signatures with 401', async () => {
    const ping = await h.app.inject(signed({ version: 1, application_id: APP_ID, type: 0 }));
    expect(ping.statusCode).toBe(204);
    expect(ping.body).toBe('');
    const tampered = signed({ version: 1, application_id: APP_ID, type: 0 });
    tampered.payload = Buffer.from(JSON.stringify({ version: 1, application_id: APP_ID, type: 1 }));
    expect((await h.app.inject(tampered)).statusCode).toBe(401);
    const stale = signed({ version: 1, application_id: APP_ID, type: 0 }, Math.floor(Date.now() / 1000) - 600);
    expect((await h.app.inject(stale)).statusCode).toBe(401);
    expect(
      (await h.app.inject({ ...signed({ type: 0 }), headers: { 'content-type': 'application/json' } })).statusCode,
    ).toBe(401);
  });

  it('stores user installs hashed exactly as the SDK would, once even when Discord retries', async () => {
    const body = authorized(USER);
    expect((await h.app.inject(signed(body))).statusCode).toBe(204);
    expect((await h.app.inject(signed(body))).statusCode).toBe(204); // retry of the same delivery
    await settle();
    const rows = await h.db.query<{ user_hash: Buffer; integration_type: number; scopes: string[] }>(
      "SELECT user_hash, integration_type, scopes FROM webhook_events WHERE type = 'APPLICATION_AUTHORIZED'",
    );
    expect(rows.rowCount).toBe(1);
    const { hasher, period } = await sdkHasher(h.app);
    const sdkHash = (await hasher.hash(USER, period))!;
    expect(rows.rows[0]?.user_hash.toString('hex')).toBe(sdkHash.split(':')[2]);
    expect(rows.rows[0]).toMatchObject({ integration_type: 1, scopes: ['applications.commands'] });
    const raw = await h.db.query(
      "SELECT count(*)::int AS n FROM webhook_events WHERE user_hash::text LIKE '%555555555555555555%'",
    );
    expect(raw.rows[0].n).toBe(0);
  });

  it('records entitlements from webhooks and rejects events for another application', async () => {
    const res = await h.app.inject(
      signed({
        version: 1,
        application_id: APP_ID,
        type: 1,
        event: {
          type: 'ENTITLEMENT_CREATE',
          timestamp: new Date().toISOString(),
          data: {
            id: '700000000000000001',
            sku_id: '700000000000000002',
            user_id: USER,
            type: 8,
            starts_at: null,
            ends_at: null,
          },
        },
      }),
    );
    expect(res.statusCode).toBe(204);
    await settle();
    const rows = await h.db.query("SELECT source, sku_id::text FROM entitlements WHERE source = 'webhook'");
    expect(rows.rows[0]).toEqual({ source: 'webhook', sku_id: '700000000000000002' });
    const other = await h.app.inject(signed({ ...authorized(USER), application_id: '1111111111111111111' }));
    expect(other.statusCode).toBe(400);
  });
});

describe('admin access', () => {
  it('needs a Discord session for settings, keys, alerts and audit data; mutations need the CSRF header', async () => {
    for (const url of ['/v1/settings', '/v1/keys', '/v1/alerts', '/v1/audit/access-log']) {
      expect((await h.app.inject({ method: 'GET', url })).statusCode, url).toBe(401);
      expect(
        (await h.app.inject({ method: 'GET', url, cookies: { shardlens_session: readCookie } })).statusCode,
        url,
      ).toBe(403);
      expect(
        (await h.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${READ_KEY}` } })).statusCode,
        url,
      ).toBe(401);
      expect(
        (await h.app.inject({ method: 'GET', url, cookies: { shardlens_session: adminCookie } })).statusCode,
        url,
      ).toBe(200);
    }
    const noCsrf = await h.app.inject({
      method: 'PUT',
      url: '/v1/settings',
      cookies: { shardlens_session: adminCookie },
      payload: { timezone: 'Europe/London' },
    });
    expect(noCsrf.statusCode).toBe(403);
  });

  it('lets no cache keep an answer: settings, keys, alerts, queries, sign-in errors', async () => {
    const admin = { cookies: { shardlens_session: adminCookie } };
    const answers = {
      settings: await h.app.inject({ method: 'GET', url: '/v1/settings', ...admin }),
      keys: await h.app.inject({ method: 'GET', url: '/v1/keys', ...admin }),
      alerts: await h.app.inject({ method: 'GET', url: '/v1/alerts', ...admin }),
      meta: await h.app.inject({ method: 'GET', url: '/v1/meta', ...admin }),
      refused: await h.app.inject({ method: 'GET', url: '/v1/settings' }),
      signIn: await h.app.inject({
        method: 'POST',
        url: '/auth/read-key',
        headers: { 'x-shardlens-csrf': '1' },
        payload: {},
      }),
    };
    for (const [name, res] of Object.entries(answers)) expect(res.headers['cache-control'], name).toBe('no-store');
  });

  it('validates settings: audit retention over 90 days and unknown fields are rejected', async () => {
    const ok = await h.app.inject({
      method: 'PUT',
      url: '/v1/settings',
      ...asAdmin(),
      payload: { timezone: 'Europe/London', requiredPermissions: '2048' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ timezone: 'Europe/London', requiredPermissions: '2048' });
    const tooLong = await h.app.inject({
      method: 'PUT',
      url: '/v1/settings',
      ...asAdmin(),
      payload: { auditRetentionDays: 91 },
    });
    expect(tooLong.statusCode).toBe(400);
    const unknown = await h.app.inject({
      method: 'PUT',
      url: '/v1/settings',
      ...asAdmin(),
      payload: { password: 'x' },
    });
    expect(unknown.statusCode).toBe(400);
    // No store method reads the admin audit back; MongoDB's is checked in mongodb-admin.int.test.ts.
    if (onPostgres) {
      const audit = await h.db.query("SELECT count(*)::int AS n FROM admin_audit WHERE action = 'settings_update'");
      expect(audit.rows[0].n).toBeGreaterThan(0);
    }
  });

  it('accepts every spelling of a time zone the database knows, and nothing else', async () => {
    const save = (timezone: string) =>
      h.app.inject({ method: 'PUT', url: '/v1/settings', ...asAdmin(), payload: { timezone } });
    for (const timezone of ['Asia/Kolkata', 'Asia/Calcutta', 'Europe/Kyiv', 'Etc/UTC']) {
      expect((await save(timezone)).statusCode, timezone).toBe(200);
    }
    for (const timezone of ['Mars/Olympus', '../../etc/passwd', 'Asia/Kolkata; DROP TABLE apps']) {
      expect((await save(timezone)).statusCode, timezone).toBe(400);
    }
    expect((await save('Europe/London')).statusCode).toBe(200);
    // A save that leaves the zone out keeps it.
    await h.app.inject({ method: 'PUT', url: '/v1/settings', ...asAdmin(), payload: { rawRetentionDays: 35 } });
    const settings = await h.app.inject({
      method: 'GET',
      url: '/v1/settings',
      cookies: { shardlens_session: adminCookie },
    });
    expect(settings.json()).toMatchObject({ timezone: 'Europe/London' });
  });

  it('refuses a sample rate whose events would carry a weight the wire refuses', async () => {
    const save = (rate: number) =>
      h.app.inject({ method: 'PUT', url: '/v1/settings', ...asAdmin(), payload: { sampling: { custom: rate } } });
    expect((await save(0.00005)).statusCode).toBe(400);
    expect((await save(0.0001)).statusCode).toBe(200);
    expect((await save(1)).statusCode).toBe(200);
  });

  it('refuses required permission bits a bigint cannot hold, and filters servers with any bits', async () => {
    const save = (requiredPermissions: string) =>
      h.app.inject({ method: 'PUT', url: '/v1/settings', ...asAdmin(), payload: { requiredPermissions } });
    expect((await save('9223372036854775808')).statusCode).toBe(400);
    expect((await save('2048')).statusCode).toBe(200);
    // A server with all 64 bits set, which only a direct write can make; the query runs on every store.
    if (onPostgres) {
      await h.db.query(
        `INSERT INTO guilds (app_id, guild_id, joined_at, bot_permissions) VALUES ($1, 400000000000000001, now(), 18446744073709551615)
         ON CONFLICT DO NOTHING`,
        [APP_ID],
      );
    }
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/query',
      cookies: { shardlens_session: adminCookie },
      payload: { kind: 'servers', missingPermissions: true },
    });
    expect(res.statusCode, res.body).toBe(200);
  });

  it('creates keys shown once, and revoked keys stop working immediately', async () => {
    const created = await h.app.inject({
      method: 'POST',
      url: '/v1/keys',
      ...asAdmin(),
      payload: { scope: 'ingest', label: 'bot 2' },
    });
    expect(created.statusCode).toBe(201);
    const { id, key } = created.json() as { id: string; key: string };
    expect(key).toMatch(/^slk_ingest_[\w-]{43}$/);
    const list = await h.app.inject({ method: 'GET', url: '/v1/keys', cookies: { shardlens_session: adminCookie } });
    expect(list.body).not.toContain(key);
    const cfg = () => h.app.inject({ method: 'GET', url: '/v1/config', headers: { authorization: `Bearer ${key}` } });
    expect((await cfg()).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'DELETE', url: `/v1/keys/${id}`, ...asAdmin() })).statusCode).toBe(200);
    expect((await cfg()).statusCode).toBe(401);
  });

  it('ends the dashboard sessions opened with a read key when that key is revoked', async () => {
    const created = await h.app.inject({
      method: 'POST',
      url: '/v1/keys',
      ...asAdmin(),
      payload: { scope: 'read', label: 'shared with a friend' },
    });
    const { id, key } = created.json() as { id: string; key: string };
    const signIn = await h.app.inject({
      method: 'POST',
      url: '/auth/read-key',
      headers: { 'x-shardlens-csrf': '1' },
      payload: { key },
    });
    expect(signIn.statusCode).toBe(200);
    const session = signIn.cookies.find((c) => c.name === 'shardlens_session')?.value as string;
    const meta = () => h.app.inject({ method: 'GET', url: '/v1/meta', cookies: { shardlens_session: session } });
    expect((await meta()).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'DELETE', url: `/v1/keys/${id}`, ...asAdmin() })).statusCode).toBe(200);
    expect((await meta()).statusCode).toBe(401);
  });

  it('takes admin access away from someone no longer on the team, without waiting for the session to end', async () => {
    const former = await testSession(h.store, 'discord', FORMER_ADMIN);
    const settings = await h.app.inject({ method: 'GET', url: '/v1/settings', cookies: { shardlens_session: former } });
    expect(settings.statusCode).toBe(403);
    expect(settings.json()).toEqual({ error: 'not_a_team_member' });
  });
});

describe('alerts', () => {
  it('only accepts Discord webhook URLs and never returns them in full', async () => {
    const evil = await h.app.inject({
      method: 'POST',
      url: '/v1/alerts',
      ...asAdmin(),
      payload: {
        name: 'x',
        metric: 'error_rate',
        comparator: '>',
        threshold: 1,
        windowS: 600,
        webhookUrl: 'https://169.254.169.254/latest',
      },
    });
    expect(evil.statusCode).toBe(400);
    const ok = await h.app.inject({
      method: 'POST',
      url: '/v1/alerts',
      ...asAdmin(),
      payload: {
        name: 'Failures',
        metric: 'error_rate',
        comparator: '>=',
        threshold: 0,
        windowS: 3600,
        webhookUrl: WEBHOOK,
      },
    });
    expect(ok.statusCode).toBe(201);
    const list = await h.app.inject({ method: 'GET', url: '/v1/alerts', cookies: { shardlens_session: adminCookie } });
    expect(list.body).not.toContain('abcDEF_token');
    expect(list.json().rules[0].webhook).toContain('•••');
  });

  it('evaluates every metric, notifies once and then debounces', async () => {
    for (const metric of ALERT_METRICS) await h.store.alerts.metricValue(APP_ID, metric, 600);
    const { hasher, period } = await sdkHasher(h.app);
    await ingest(
      h.app,
      envelope([interaction((await hasher.hash('121212121212121212', period))!, { outcome: 'error' })]),
    );
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(`${String(url)} ${String(init?.body)}`);
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const opts = { settingsKey: h.config.settingsKey, dashboardUrl: h.config.publicUrl, fetchImpl };
    expect(await runAlerts(h.store, opts)).toBe(1);
    expect(await runAlerts(h.store, opts)).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('with_components=true');
    expect(calls[0]).toContain('"parse":[]');
  });

  it('records an alert whose webhook can no longer be decrypted, instead of skipping it silently', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const rotatedKey = Buffer.alloc(32, 9).toString('base64');
    // Past the 30 minutes the rule waits after firing in the test before.
    const later = new Date(Date.now() + 31 * 60_000);
    const opts = { settingsKey: rotatedKey, dashboardUrl: h.config.publicUrl, fetchImpl };
    expect(await runAlerts(h.store, opts, later)).toBe(0);
    expect(calls).toEqual([]);
    const [latest] = await h.store.alerts.history(APP_ID);
    expect(latest).toMatchObject({ ts: later, delivered: false });
    expect(latest?.error).toMatch(/could not be decrypted/);
  });

  it('answers a test of an alert whose webhook can no longer be decrypted with the reason, not a 500', async () => {
    const stale = auditCipher(Buffer.alloc(32, 9).toString('base64')).encrypt(WEBHOOK);
    const id = await h.store.alerts.create(APP_ID, {
      name: 'stale key',
      metric: 'error_rate',
      comparator: '>',
      threshold: 1,
      windowS: 300,
      webhook: stale,
    });
    try {
      const res = await h.app.inject({ method: 'POST', url: `/v1/alerts/${id}/test`, ...asAdmin() });
      expect(res.statusCode).toBe(502);
      expect(res.json()).toMatchObject({ error: 'webhook_failed', message: expect.stringMatching(/decrypted/) });
    } finally {
      await h.store.alerts.delete(APP_ID, id);
    }
  });
});

describe('scheduled reports', () => {
  // The daily report covers the day before "now", so run it as if it were tomorrow to report on today's test traffic.
  const tomorrow = (hour = 12) => {
    const d = new Date(Date.now() + 86_400_000);
    d.setUTCHours(hour, 0, 0, 0);
    return d;
  };
  const discord = (status = 204) => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(`${String(url)} ${String(init?.body)}`);
      return new Response(null, { status });
    }) as typeof fetch;
    return { calls, opts: { settingsKey: h.config.settingsKey, dashboardUrl: h.config.publicUrl, fetchImpl } };
  };
  const create = (payload: object) => h.app.inject({ method: 'POST', url: '/v1/reports', ...asAdmin(), payload });
  const list = async () =>
    (await h.app.inject({ method: 'GET', url: '/v1/reports', cookies: { shardlens_session: adminCookie } })).json()
      .reports as { id: string; name: string; webhook: string; lastSent: string | null; lastError: string | null }[];

  it('only accepts Discord webhooks, needs an admin and never returns the URL in full', async () => {
    const report = { name: 'Morning summary', schedule: 'daily', hour: 9, webhookUrl: WEBHOOK };
    expect((await create({ ...report, webhookUrl: 'https://169.254.169.254/latest' })).statusCode).toBe(400);
    expect((await create({ ...report, hour: 24 })).statusCode).toBe(400);
    const asReader = await h.app.inject({
      method: 'POST',
      url: '/v1/reports',
      cookies: { shardlens_session: readCookie },
      headers: { 'x-shardlens-csrf': '1' },
      payload: report,
    });
    expect(asReader.statusCode).toBe(403);

    expect((await create(report)).statusCode).toBe(201);
    const [saved] = await list();
    expect(saved).toMatchObject({ name: 'Morning summary', lastSent: null });
    expect(saved?.webhook).toContain('•••');
    expect(JSON.stringify(saved)).not.toContain('abcDEF_token');
  });

  it('waits for its hour, then posts the finished day once, with counts and no user', async () => {
    const { hasher, period } = await sdkHasher(h.app);
    const user = (await hasher.hash('343434343434343434', period))!;
    // A command name that tries to start a new line with a heading and a link of its own.
    const hostile = 'x\n# pwned [a](http://e.vil)';
    await ingest(
      h.app,
      envelope([
        interaction(user, { command: 'ticket' }),
        interaction(user, { command: 'help' }),
        ...[1, 2, 3].map(() => interaction(user, { command: hostile })),
      ]),
    );
    await h.store.jobs.runRollups(new Date());
    await h.store.jobs.runUniques();

    const { calls, opts } = discord();
    expect(await runReports(h.store, opts, tomorrow(8))).toBe(0);
    expect(await runReports(h.store, opts, tomorrow(9))).toBe(1);
    expect(await runReports(h.store, opts, tomorrow(15))).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('Daily report');
    expect(calls[0]).toContain('Commands run');
    expect(calls[0]).toContain('`/ticket`');
    expect(calls[0]).toContain('`/x# pwned [a](http://e.vil)`');
    expect(calls[0]).not.toContain('\\n# pwned');
    expect(calls[0]).toContain('"parse":[]');
    expect(calls[0]).not.toContain('343434343434343434');
    expect((await list())[0]).toMatchObject({ lastError: null });
  });

  it('sends a weekly report on its weekday only', async () => {
    for (const report of await h.store.reports.list(APP_ID)) await h.store.reports.delete(APP_ID, report.id);
    const when = tomorrow();
    const today = when.getUTCDay() || 7;
    const otherDay = (today % 7) + 1;
    await create({ name: 'Wrong day', schedule: 'weekly', hour: 0, weekday: otherDay, webhookUrl: WEBHOOK });
    const { calls, opts } = discord();
    expect(await runReports(h.store, opts, when)).toBe(0);
    await create({ name: 'Right day', schedule: 'weekly', hour: 0, weekday: today, webhookUrl: WEBHOOK });
    expect(await runReports(h.store, opts, when)).toBe(1);
    expect(calls[0]).toContain('Weekly report');
  });

  // Clearing `last_sent` takes a direct write: MongoDB's errors and sends are checked in mongodb-admin.int.test.ts.
  it.runIf(onPostgres)('records why a delivery failed and does not retry all day', async () => {
    await h.db.query('UPDATE reports SET last_sent = NULL');
    const { calls, opts } = discord(404);
    expect(await runReports(h.store, opts, tomorrow())).toBe(0);
    const attempts = calls.length;
    expect(await runReports(h.store, opts, tomorrow())).toBe(0);
    expect(calls).toHaveLength(attempts);
    expect((await list()).map((r) => r.lastError)).toContain('discord returned 404');
  });

  // Writes unique counts directly. MongoDB's local days, across DST changes, are compared with PostgreSQL's in
  // mongodb-admin.int.test.ts.
  it.runIf(onPostgres)('reports the unique users of the local day, for a bot whose time zone is not UTC', async () => {
    // Run at 15:00 UTC tomorrow, New York's finished day is today's date: 05:00 UTC today to 05:00 UTC tomorrow
    // (04:00 in summer). Unique users are counted per UTC day, and three of those touch it.
    const today = new Date().toISOString().slice(0, 10);
    const utcDay = (offset: number) => new Date(Date.parse(today) + offset * 86_400_000).toISOString().slice(0, 10);
    const { hasher, period } = await sdkHasher(h.app);
    const user = (await hasher.hash('565656565656565656', period))!;
    const ran = Date.parse(`${today}T17:00:00Z`);
    await ingest(h.app, envelope([interaction(user, { command: 'ticket', ts: ran })]));
    await h.store.jobs.backfillRollups(new Date(ran), new Date(ran + 60_000));
    for (const [day, users] of [
      [utcDay(-1), 11],
      [today, 22],
      [utcDay(1), 33],
    ] as const) {
      await h.db.query(
        `INSERT INTO unique_counts (app_id, grain, start_day, scope, scope_key, users, new_users, final)
         VALUES ($1, 'day', $2, 'global', '*', $3, 0, false)
         ON CONFLICT (app_id, grain, start_day, scope, scope_key) DO UPDATE SET users = EXCLUDED.users`,
        [APP_ID, day, users],
      );
    }
    await h.db.query('DELETE FROM reports');
    await h.db.query("UPDATE apps SET timezone = 'America/New_York' WHERE app_id = $1", [APP_ID]);
    try {
      await create({ name: 'New York', schedule: 'daily', hour: 0, webhookUrl: WEBHOOK });
      const { calls, opts } = discord();
      expect(await runReports(h.store, opts, tomorrow(15))).toBe(1);
      expect(calls[0]).toContain('(America/New_York)');
      expect(calls[0]).toContain('Unique users: **22**');
    } finally {
      await h.db.query("UPDATE apps SET timezone = 'UTC' WHERE app_id = $1", [APP_ID]);
    }
  });
});

describe('audit mode', () => {
  const ACTIVITY_KEY = `slk_activity_${'C'.repeat(43)}`;
  const withKey = (key: string, url: string) =>
    h.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${key}` } });

  it('has nothing for an activity key to read while users are hashed', async () => {
    await seedKey(h.store, APP_ID, ACTIVITY_KEY, 'SHARDLENS_ACTIVITY_KEY');
    const settings = await h.app.inject({ method: 'GET', url: '/v1/settings', ...asAdmin() });
    expect(settings.json()).toMatchObject({ mode: 'privacy', modeSetByEnvironment: false });
    for (const url of ['/v1/audit/log', '/v1/audit/top-users']) {
      const res = await withKey(ACTIVITY_KEY, url);
      expect(res.statusCode, url).toBe(404);
      expect(res.json(), url).toEqual({ error: 'audit_mode_off' });
    }
    // The numbers are there in either mode.
    expect((await withKey(ACTIVITY_KEY, '/v1/meta')).json()).toMatchObject({ mode: 'privacy' });
  });

  it('cannot be switched on without the audit key on the collector', async () => {
    // This harness has the key, so the switch works; the negative case is covered by the settings validator.
    const on = await h.app.inject({
      method: 'PUT',
      url: '/v1/settings',
      ...asAdmin(),
      payload: { mode: 'audit', auditRetentionDays: 30 },
    });
    expect(on.json()).toMatchObject({ mode: 'audit', auditRetentionDays: 30 });
  });

  it('stores who ran what encrypted, shows it only to admins and logs every view, lookup and export', async () => {
    const { hasher, period } = await sdkHasher(h.app);
    const user = (await hasher.hash(USER, period))!;
    const res = await ingest(
      h.app,
      envelope(
        [
          interaction(user, {
            command: 'audited',
            actor: { userId: USER, username: 'someone', avatar: '0123456789abcdef0123456789abcdef' },
          }),
        ],
        {
          mode: 'audit',
        },
      ),
    );
    expect(res.json()).toMatchObject({ accepted: 1 });
    const [stored] = await h.store.privacy.activity(APP_ID, {}, 1);
    expect(stored?.userId.toString('utf8')).not.toContain(USER);

    expect(
      (await h.app.inject({ method: 'GET', url: '/v1/audit/log', cookies: { shardlens_session: readCookie } }))
        .statusCode,
    ).toBe(403);
    const log = await h.app.inject({
      method: 'GET',
      url: `/v1/audit/log?user=${USER}`,
      cookies: { shardlens_session: adminCookie },
    });
    expect(log.json().rows[0]).toMatchObject({ userId: USER, username: 'someone', command: 'audited' });
    const top = await h.app.inject({
      method: 'GET',
      url: '/v1/audit/top-users?window=24h',
      cookies: { shardlens_session: adminCookie },
    });
    expect(top.json().rows[0]).toMatchObject({ userId: USER, runs: 1 });

    const noConfirm = await h.app.inject({ method: 'GET', url: '/v1/audit/export.csv', ...asAdmin() });
    expect(noConfirm.statusCode).toBe(428);
    const csv = await h.app.inject({
      method: 'GET',
      url: '/v1/audit/export.csv',
      ...asAdmin({ 'x-shardlens-confirm': 'export-audit-log' }),
    });
    expect(csv.statusCode).toBe(200);
    expect(csv.body).toContain(USER);

    const access = await h.store.privacy.accessLog(APP_ID);
    expect(access.map((r) => r.action)).toEqual(expect.arrayContaining(['lookup_user', 'top_users', 'export']));
    expect(JSON.stringify(access.filter((r) => r.action === 'lookup_user'))).not.toContain(USER);
  });

  it('records who ran a prefix command the same way', async () => {
    const { hasher, period } = await sdkHasher(h.app);
    const user = (await hasher.hash(USER, period))!;
    const res = await ingest(
      h.app,
      envelope(
        [
          {
            id: uuidv7(),
            ts: Date.now(),
            type: 'message_command',
            command: 'warn',
            user,
            outcome: 'ok',
            actor: { userId: USER, username: 'someone' },
          },
        ],
        { mode: 'audit' },
      ),
    );
    expect(res.json()).toMatchObject({ accepted: 1 });
    const log = await h.app.inject({
      method: 'GET',
      url: `/v1/audit/log?user=${USER}`,
      cookies: { shardlens_session: adminCookie },
    });
    expect(log.json().rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: USER, kind: 'message_command', command: 'warn', outcome: 'ok' }),
      ]),
    );
  });

  it('pages through rows recorded in the same millisecond without skipping any', async () => {
    const { hasher, period } = await sdkHasher(h.app);
    const user = (await hasher.hash(USER, period))!;
    const ts = Date.now() - 60_000;
    const runs = [1, 2, 3].map(() => ({
      id: uuidv7(ts),
      ts,
      type: 'message_command',
      command: 'paged',
      user,
      outcome: 'ok',
      actor: { userId: USER },
    }));
    expect((await ingest(h.app, envelope(runs, { mode: 'audit' }))).json()).toMatchObject({ accepted: 3 });
    const page = (before?: string) =>
      h.app.inject({
        method: 'GET',
        url: `/v1/audit/log?command=paged&limit=2${before ? `&before=${encodeURIComponent(before)}` : ''}`,
        cookies: { shardlens_session: adminCookie },
      });
    const first = (await page()).json() as { rows: { interactionId: string }[]; nextBefore: string };
    expect(first.rows).toHaveLength(2);
    const second = (await page(first.nextBefore)).json() as { rows: { interactionId: string }[] };
    expect(second.rows).toHaveLength(1);
    const seen = [...first.rows, ...second.rows].map((r) => r.interactionId).sort();
    expect(seen).toEqual(runs.map((r) => r.id.toLowerCase()).sort());
  });

  it('refuses a filter it does not know, instead of ignoring it and showing every row', async () => {
    const misspelt = await h.app.inject({
      method: 'GET',
      url: `/v1/audit/log?userId=${USER}`,
      cookies: { shardlens_session: adminCookie },
    });
    expect(misspelt.statusCode).toBe(400);
    const exported = await h.app.inject({
      method: 'GET',
      url: '/v1/audit/export.csv?server=112233445566778899',
      ...asAdmin({ 'x-shardlens-confirm': 'export-audit-log' }),
    });
    expect(exported.statusCode).toBe(400);
  });

  it('narrows the log and its export to failed runs, or to one outcome', async () => {
    const { hasher, period } = await sdkHasher(h.app);
    const user = (await hasher.hash(USER, period))!;
    const runs = ['ok', 'error', 'timeout', 'no_response'].map((outcome) =>
      interaction(user, {
        command: 'flaky',
        outcome,
        ...(outcome === 'no_response' ? { ackMs: undefined } : {}),
        actor: { userId: USER },
      }),
    );
    expect((await ingest(h.app, envelope(runs, { mode: 'audit' }))).json()).toMatchObject({ accepted: 4 });
    const outcomes = async (filter: string) => {
      const log = await h.app.inject({
        method: 'GET',
        url: `/v1/audit/log?command=flaky&${filter}`,
        cookies: { shardlens_session: adminCookie },
      });
      return (log.json().rows as { outcome: string }[]).map((row) => row.outcome).sort();
    };
    expect(await outcomes('outcome=failed')).toEqual(['error', 'no_response', 'timeout']);
    expect(await outcomes('outcome=failed&guild=112233445566778899')).toEqual(['error', 'no_response', 'timeout']);
    expect(await outcomes('outcome=failed&guild=998877665544332211')).toEqual([]);
    expect(await outcomes('outcome=timeout')).toEqual(['timeout']);
    expect(await outcomes('outcome=ok')).toEqual(['ok']);

    const unknown = await h.app.inject({
      method: 'GET',
      url: '/v1/audit/log?outcome=broken',
      cookies: { shardlens_session: adminCookie },
    });
    expect(unknown.statusCode).toBe(400);

    const csv = await h.app.inject({
      method: 'GET',
      url: '/v1/audit/export.csv?command=flaky&outcome=failed',
      ...asAdmin({ 'x-shardlens-confirm': 'export-audit-log' }),
    });
    expect(csv.body.trim().split('\n')).toHaveLength(4);
    expect(csv.body).not.toContain(',ok,');

    const views = (await h.store.privacy.accessLog(APP_ID))
      .filter((row) => row.action === 'view_log')
      .map((row) => row.details as { command: string | null; outcome: string | null })
      .filter((details) => details.command === 'flaky');
    expect(views.map((details) => details.outcome)).toEqual(expect.arrayContaining(['failed', 'timeout', 'ok']));
  });

  // PostgreSQL's plans; MongoDB's indexes that hold only failures are checked in mongodb-admin.int.test.ts.
  it.runIf(onPostgres)('reads the newest failures from the indexes that hold only failures', async () => {
    const failureIndexes = await h.db.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE tablename LIKE 'audit_log\\_%' AND indexdef LIKE '%WHERE (outcome <> 0)'`,
    );
    const named = (perServer: boolean) =>
      failureIndexes.rows.filter((row) => row.indexdef.includes('guild_id') === perServer).map((row) => row.indexname);
    const plan = async (where: string) => {
      const client = await h.db.connect();
      try {
        // A table this small is read whole and sorted unless told otherwise; this asks whether an index can serve
        // the log's query as the route writes it.
        await client.query('BEGIN');
        await client.query(
          'SET LOCAL enable_seqscan = off; SET LOCAL enable_bitmapscan = off; SET LOCAL enable_sort = off',
        );
        const res = await client.query<{ 'QUERY PLAN': string }>(
          `EXPLAIN SELECT a.interaction_id FROM audit_log a WHERE a.app_id = ${APP_ID} AND ${where}
            ORDER BY a.ts DESC, a.interaction_id DESC LIMIT 50`,
        );
        return res.rows.map((row) => row['QUERY PLAN']).join('\n');
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    };
    const everywhere = await plan('a.outcome <> 0');
    expect(named(false).some((index) => everywhere.includes(index))).toBe(true);
    const oneServer = await plan('a.guild_id = 112233445566778899 AND a.outcome <> 0 AND a.outcome = 2');
    expect(named(true).some((index) => oneServer.includes(index))).toBe(true);
  });

  it('lets an activity key read who ran what for a dashboard of your own, and logs each read under the key', async () => {
    const created = await h.app.inject({
      method: 'POST',
      url: '/v1/keys',
      ...asAdmin(),
      payload: { scope: 'activity', label: 'my dashboard' },
    });
    // The name of an environment variable is refused: a new value of that variable would revoke the key.
    const reserved = await h.app.inject({
      method: 'POST',
      url: '/v1/keys',
      ...asAdmin(),
      payload: { scope: 'read', label: 'SHARDLENS_READ_KEY' },
    });
    expect(reserved.statusCode).toBe(400);
    expect(created.statusCode).toBe(201);
    const { id, key } = created.json() as { id: string; key: string };
    expect(key).toMatch(/^slk_activity_[\w-]{43}$/);

    const log = await withKey(key, '/v1/audit/log?command=flaky&outcome=failed');
    expect(log.statusCode).toBe(200);
    expect(log.json().rows).toHaveLength(3);
    expect(log.json().rows[0]).toMatchObject({ userId: USER, command: 'flaky' });
    expect((await withKey(key, '/v1/audit/top-users?window=24h')).json().rows[0]).toMatchObject({ userId: USER });
    // A page that refreshes asks again and again: the same read within a minute is one line of the access log.
    expect((await withKey(key, '/v1/audit/log?command=flaky&outcome=failed')).statusCode).toBe(200);
    // Paging is not a refresh: each page read is a line of its own, however quickly the pages follow each other.
    const first = await withKey(key, '/v1/audit/log?command=flaky&outcome=failed&limit=1');
    const second = `/v1/audit/log?command=flaky&outcome=failed&limit=1&before=${encodeURIComponent(first.json().nextBefore)}`;
    expect((await withKey(key, second)).json().rows).toHaveLength(1);
    expect((await withKey(key, second)).statusCode).toBe(200);
    // One key for a whole dashboard: it runs the queries a read key runs.
    const overview = await h.app.inject({
      method: 'POST',
      url: '/v1/query',
      headers: { authorization: `Bearer ${key}` },
      payload: { kind: 'overview' },
    });
    expect(overview.statusCode).toBe(200);

    // Oldest first: the access log lists the newest first.
    const reads = (await h.store.privacy.accessLog(APP_ID)).filter((row) => row.viewerKey !== null).reverse();
    expect(reads.map(({ action, viewerUserId, viewerKey }) => ({ action, viewerUserId, viewerKey }))).toEqual([
      { action: 'view_log', viewerUserId: '0', viewerKey: 'my dashboard' },
      { action: 'top_users', viewerUserId: '0', viewerKey: 'my dashboard' },
      { action: 'view_log', viewerUserId: '0', viewerKey: 'my dashboard' },
      { action: 'view_log', viewerUserId: '0', viewerKey: 'my dashboard' },
    ]);
    const shown = await h.app.inject({ method: 'GET', url: '/v1/audit/access-log', ...asAdmin() });
    expect(shown.json().rows).toEqual(
      expect.arrayContaining([expect.objectContaining({ action: 'view_log', viewerKey: 'my dashboard' })]),
    );

    // A read key is told which key it needs; any other key is no key at all.
    const withReadKey = await withKey(READ_KEY, '/v1/audit/log');
    expect(withReadKey.statusCode).toBe(403);
    expect(withReadKey.json()).toEqual({ error: 'activity_key_required' });
    expect((await withKey(INGEST_KEY, '/v1/audit/log')).statusCode).toBe(401);
    expect((await withKey(`slk_activity_${'Z'.repeat(43)}`, '/v1/audit/top-users')).statusCode).toBe(401);
    // Exports, the access log, settings and keys stay with a person signed in with Discord.
    for (const url of ['/v1/audit/export.csv', '/v1/audit/access-log', '/v1/settings', '/v1/keys']) {
      expect((await withKey(key, url)).statusCode, url).toBe(401);
    }
    const signIn = await h.app.inject({
      method: 'POST',
      url: '/auth/read-key',
      headers: { 'x-shardlens-csrf': '1' },
      payload: { key },
    });
    expect(signIn.statusCode).toBe(401);

    expect((await h.app.inject({ method: 'DELETE', url: `/v1/keys/${id}`, ...asAdmin() })).statusCode).toBe(200);
    expect((await withKey(key, '/v1/audit/log')).statusCode).toBe(401);
  });

  it('keeps the mode the collector was configured with, whatever Settings asks for', async () => {
    h.config.mode = 'audit';
    try {
      const settings = await h.app.inject({ method: 'GET', url: '/v1/settings', ...asAdmin() });
      expect(settings.json()).toMatchObject({ mode: 'audit', modeSetByEnvironment: true });
      const change = await h.app.inject({
        method: 'PUT',
        url: '/v1/settings',
        ...asAdmin(),
        payload: { mode: 'privacy' },
      });
      expect(change.statusCode).toBe(409);
      expect(change.json()).toMatchObject({ error: 'mode_set_by_environment' });
      // Saving the rest of the form, which sends the same mode back, still works.
      const same = await h.app.inject({
        method: 'PUT',
        url: '/v1/settings',
        ...asAdmin(),
        payload: { mode: 'audit', auditRetentionDays: 30 },
      });
      expect(same.statusCode).toBe(200);
      expect(same.json()).toMatchObject({ mode: 'audit' });
    } finally {
      h.config.mode = undefined;
    }
  });

  it('erases a user everywhere on request: hashed rows, unique users and the encrypted activity log', async () => {
    const erase = await h.app.inject({
      method: 'POST',
      url: '/v1/privacy/erase',
      ...asAdmin(),
      payload: { userId: USER },
    });
    expect(erase.statusCode).toBe(200);
    expect(erase.json().erased).toBeGreaterThan(0);
    expect(await h.store.privacy.activity(APP_ID, {}, 200)).toEqual([]);
    // Rows by hash are read back only by SQL; MongoDB's erase of each collection is checked in
    // mongodb-admin.int.test.ts.
    if (onPostgres) {
      const { hasher, period } = await sdkHasher(h.app);
      const bytes = Buffer.from((await hasher.hash(USER, period))!.split(':')[2]!, 'hex');
      for (const table of ['interactions', 'uniques', 'webhook_events', 'entitlements']) {
        const r = await h.db.query(`SELECT count(*)::int AS n FROM ${table} WHERE user_hash = $1`, [bytes]);
        expect(r.rows[0].n, table).toBe(0);
      }
    }
  });

  it('lets the SDK erase by hash, and refuses raw IDs from the SDK in privacy mode', async () => {
    await h.app.inject({ method: 'PUT', url: '/v1/settings', ...asAdmin(), payload: { mode: 'privacy' } });
    const { hasher, period } = await sdkHasher(h.app);
    const hash = (await hasher.hash('343434343434343434', period))!;
    await ingest(h.app, envelope([interaction(hash, { command: 'to_forget' })]));
    const raw = await h.app.inject({
      method: 'POST',
      url: '/v1/privacy/erase',
      headers: { authorization: `Bearer ${INGEST_KEY}` },
      payload: { userId: '343434343434343434' },
    });
    expect(raw.statusCode).toBe(400);
    const ok = await h.app.inject({
      method: 'POST',
      url: '/v1/privacy/erase',
      headers: { authorization: `Bearer ${INGEST_KEY}` },
      payload: { userHashes: [hash] },
    });
    expect(ok.json().erased).toBeGreaterThan(0);
    if (onPostgres) {
      const left = await h.db.query("SELECT count(*)::int AS n FROM interactions WHERE command = 'to_forget'");
      expect(left.rows[0].n).toBe(0);
    }
  });
});

describe('every route needs the right credentials', () => {
  it('refuses requests without credentials or with the wrong scope', async () => {
    const routes: [string, string, unknown?][] = [
      ['POST', '/v1/ingest', {}],
      ['GET', '/v1/config'],
      ['POST', '/v1/query', { kind: 'overview' }],
      ['GET', '/v1/meta'],
      ['GET', '/v1/live'],
      ['POST', '/v1/privacy/erase', { userHashes: [] }],
      ['GET', '/v1/settings'],
      ['PUT', '/v1/settings', {}],
      ['GET', '/v1/keys'],
      ['POST', '/v1/keys', {}],
      ['DELETE', '/v1/keys/1'],
      ['GET', '/v1/alerts'],
      ['POST', '/v1/alerts', {}],
      ['GET', '/v1/audit/log'],
      ['GET', '/v1/audit/top-users'],
      ['GET', '/v1/audit/export.csv'],
      ['GET', '/v1/audit/access-log'],
    ];
    for (const [method, url, payload] of routes) {
      const res = await h.app.inject({
        method: method as 'GET',
        url,
        ...(payload ? { payload: payload as object } : {}),
      });
      expect([401, 403], `${method} ${url} without credentials`).toContain(res.statusCode);
      const wrongScope = await h.app.inject({
        method: method as 'GET',
        url,
        headers: { authorization: `Bearer ${url === '/v1/ingest' || url === '/v1/config' ? READ_KEY : INGEST_KEY}` },
        ...(payload ? { payload: payload as object } : {}),
      });
      if (url !== '/v1/privacy/erase')
        expect([401, 403], `${method} ${url} with the wrong key`).toContain(wrongScope.statusCode);
    }
  });
});

describe('reliability, premium and badge queries', () => {
  const range = {
    from: new Date(Date.now() - 7 * 86_400_000).toISOString(),
    to: new Date(Date.now() + 60_000).toISOString(),
  };

  it('answers the reliability, premium and installs queries', async () => {
    for (const spec of [
      { kind: 'reliability', range },
      { kind: 'premium', range },
      { kind: 'installs', range, timezone: 'Europe/London' },
    ]) {
      const res = await query(h.app, spec);
      expect(res.statusCode, `${spec.kind}: ${res.body}`).toBe(200);
    }
  });

  it('serves a badge only when it is switched on', async () => {
    expect((await h.app.inject({ method: 'GET', url: '/v1/badge/servers.svg' })).statusCode).toBe(404);
    await h.app.inject({ method: 'PUT', url: '/v1/settings', ...asAdmin(), payload: { badges: ['servers'] } });
    const res = await h.app.inject({ method: 'GET', url: '/v1/badge/servers.svg' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('image/svg+xml');
    expect(res.headers['cache-control']).toBe('public, max-age=600');
    expect(res.body).toContain('servers');
  });
});
