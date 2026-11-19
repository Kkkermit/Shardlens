import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readdirSync, readFileSync } from 'node:fs';
import { batchJsonSchema } from '@shardlens/schema';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db.js';
import { dashboardUrl, ENV_VARIABLES, loadConfig } from '../src/env.js';
import { parseUserHash } from '../src/ingest/codes.js';
import { startJobs } from '../src/jobs/scheduler.js';
import { LiveHub } from '../src/live.js';
import { openApiDocument } from '../src/openapi.js';
import { rollupSource } from '../src/query/rollup-source.js';
import { KeyStore } from '../src/security/auth.js';
import { buildServer, clientKey } from '../src/server.js';
import { periodBounds, periodIdent } from '../src/storage/periods.js';

const base = {
  DATABASE_URL: 'postgres://localhost/shardlens',
  SHARDLENS_PUBLIC_URL: 'https://stats.example.com',
  SHARDLENS_APP_ID: '1234567890123456789',
  SHARDLENS_SESSION_SECRET: 'x'.repeat(40),
  SHARDLENS_SETTINGS_KEY: Buffer.alloc(32, 1).toString('base64'),
};

/** A pool connection that answers every query with `rows` and records how it was released. */
function fakeClient(rows: object[] = []) {
  const released: unknown[] = [];
  const client = Object.assign(new EventEmitter(), {
    query: async () => ({ rows, rowCount: rows.length }),
    release: (broken?: boolean) => void released.push(broken ?? false),
  });
  return { client, released };
}

describe('loadConfig', () => {
  it('reads the trusted proxy setting as a hop count, true or false', () => {
    expect(loadConfig({ ...base, SHARDLENS_TRUST_PROXY: '1' }).trustProxy).toBe(1);
    expect(loadConfig({ ...base, SHARDLENS_TRUST_PROXY: 'true' }).trustProxy).toBe(true);
    expect(loadConfig(base).trustProxy).toBe(false);
    expect(() => loadConfig({ ...base, SHARDLENS_TRUST_PROXY: 'yes' })).toThrow(/SHARDLENS_TRUST_PROXY/);
  });

  it('loads a minimal valid configuration', () => {
    const config = loadConfig(base);
    expect(config.port).toBe(8080);
    expect(config.discord).toBeUndefined();
  });

  it('refuses to start without required secrets, naming variables but never printing values', () => {
    const secret = 'short-secret-value';
    expect(() => loadConfig({ ...base, SHARDLENS_SESSION_SECRET: secret })).toThrow(/SHARDLENS_SESSION_SECRET/);
    try {
      loadConfig({ ...base, SHARDLENS_SESSION_SECRET: secret });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
    expect(() => loadConfig({ ...base, SHARDLENS_SETTINGS_KEY: 'too-short' })).toThrow(/SHARDLENS_SETTINGS_KEY/);
    const { DATABASE_URL: _, ...noDb } = base;
    expect(() => loadConfig(noDb)).toThrow(/DATABASE_URL/);
  });

  it('treats empty optional values from an .env file as unset', () => {
    const config = loadConfig({ ...base, DISCORD_CLIENT_ID: '', DISCORD_CLIENT_SECRET: '', SHARDLENS_AUDIT_KEY: ' ' });
    expect(config.discord).toBeUndefined();
    expect(config.auditKey).toBeUndefined();
  });

  it('needs both Discord OAuth variables or neither', () => {
    expect(() => loadConfig({ ...base, DISCORD_CLIENT_ID: '1234567890123456789' })).toThrow(/DISCORD_CLIENT_SECRET/);
  });

  it('serves the dashboard unless told not to, and then has no dashboard to link to', () => {
    const usual = loadConfig(base);
    expect(usual).toMatchObject({ dashboard: true, mode: undefined, activityKey: undefined });
    expect(dashboardUrl(usual)?.href).toBe('https://stats.example.com/');
    const headless = loadConfig({ ...base, SHARDLENS_DASHBOARD: 'off' });
    expect(headless.dashboard).toBe(false);
    expect(dashboardUrl(headless)).toBeUndefined();
    expect(() => loadConfig({ ...base, SHARDLENS_DASHBOARD: 'no' })).toThrow(/SHARDLENS_DASHBOARD/);
  });

  it('takes the mode from the environment, and audit mode only with the key that encrypts it', () => {
    const auditKey = Buffer.alloc(32, 2).toString('base64');
    const activityKey = `slk_activity_${'A'.repeat(43)}`;
    expect(
      loadConfig({
        ...base,
        SHARDLENS_MODE: 'audit',
        SHARDLENS_AUDIT_KEY: auditKey,
        SHARDLENS_ACTIVITY_KEY: activityKey,
      }),
    ).toMatchObject({ mode: 'audit', activityKey });
    expect(loadConfig({ ...base, SHARDLENS_MODE: 'privacy' }).mode).toBe('privacy');
    expect(() => loadConfig({ ...base, SHARDLENS_MODE: 'audit' })).toThrow(
      /SHARDLENS_MODE=audit needs SHARDLENS_AUDIT_KEY/,
    );
    expect(() => loadConfig({ ...base, SHARDLENS_ACTIVITY_KEY: `slk_read_${'A'.repeat(43)}` })).toThrow(
      /SHARDLENS_ACTIVITY_KEY/,
    );
  });
});

/** Read by `docker-compose.yml` and its ClickHouse override, not by the collector. */
const COMPOSE_ONLY = ['SHARDLENS_DOMAIN', 'POSTGRES_PASSWORD', 'SHARDLENS_IMAGE', 'CLICKHOUSE_PASSWORD'];

describe('docs stay in step with the code', () => {
  it('documents every environment variable the collector reads', () => {
    const page = readFileSync(
      new URL('../../docs/src/content/docs/reference/environment.mdx', import.meta.url),
      'utf8',
    );
    const missing = ENV_VARIABLES.filter((name) => !page.includes(`\`${name}\``));
    expect(missing).toEqual([]);
    // And documents nothing it doesn't read, apart from the variables Docker Compose itself reads.
    const listed = [...page.matchAll(/^\| `([A-Z][A-Z0-9_]*)`/gm)].map((m) => m[1] as string);
    expect(listed.filter((name) => !ENV_VARIABLES.includes(name) && !COMPOSE_ONLY.includes(name))).toEqual([]);
    expect(COMPOSE_ONLY.filter((name) => !listed.includes(name))).toEqual([]);
  });

  it('lists every environment variable in deploy/.env.example, and nothing else', () => {
    const example = readFileSync(new URL('../../../deploy/.env.example', import.meta.url), 'utf8');
    const names = [...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1] as string);
    expect(ENV_VARIABLES.filter((name) => !names.includes(name))).toEqual([]);
    expect(names.filter((name) => !ENV_VARIABLES.includes(name) && !COMPOSE_ONLY.includes(name))).toEqual([]);
    // The values it suggests are valid, apart from the ones the operator has to fill in.
    const filled: Record<string, string> = { ...base };
    for (const line of example.split('\n')) {
      const m = /^([A-Z][A-Z0-9_]*)=(.+)$/.exec(line);
      if (m) filled[m[1] as string] = m[2] as string;
    }
    expect(() => loadConfig(filled)).not.toThrow();
  });

  it('describes every route in the OpenAPI document with valid security schemes', () => {
    const doc = openApiDocument('1.2.3') as {
      openapi: string;
      info: { version: string };
      paths: Record<string, Record<string, { security?: Record<string, unknown>[]; responses: object }>>;
      components: { securitySchemes: Record<string, unknown> };
    };
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.version).toBe('1.2.3');
    // Served and published without an argument: the collector's own version, not a placeholder.
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    expect((openApiDocument() as typeof doc).info.version).toBe(manifest.version);
    for (const path of [
      '/v1/ingest',
      '/v1/config',
      '/v1/query',
      '/v1/privacy/erase',
      '/v1/discord/events',
      '/healthz',
    ]) {
      expect(doc.paths[path], path).toBeDefined();
    }
    const schemes = new Set(Object.keys(doc.components.securitySchemes));
    for (const [path, ops] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(ops)) {
        expect(Object.keys(op.responses).length, `${method} ${path}`).toBeGreaterThan(0);
        for (const requirement of op.security ?? []) {
          for (const name of Object.keys(requirement))
            expect(schemes.has(name), `${method} ${path}: ${name}`).toBe(true);
        }
      }
    }
    // Generated from the zod schemas: the ingest body describes the event union, and the query body has no user grouping.
    const json = JSON.stringify(doc);
    expect(json).toContain('interaction_error');
    expect(json).not.toMatch(/"groupBy"[^}]*"user"/);
    // The ingest body is the published batch schema, privacy-mode rule included.
    const ingestBody = (
      doc.paths['/v1/ingest'] as unknown as {
        post: { requestBody: { content: { 'application/json': { schema: Record<string, unknown> } } } };
      }
    ).post.requestBody.content['application/json'].schema;
    expect(ingestBody).toEqual(batchJsonSchema());
    expect(JSON.stringify(ingestBody.then)).toContain('actor');
  });

  it('lists the filters of the activity log and of its export', () => {
    const doc = openApiDocument('1.2.3') as {
      paths: Record<string, { get: { parameters?: { name: string; in: string }[] } }>;
    };
    for (const path of ['/v1/audit/log', '/v1/audit/export.csv']) {
      const parameters = doc.paths[path]?.get.parameters ?? [];
      expect(parameters.every((parameter) => parameter.in === 'query')).toBe(true);
      expect(
        parameters.map((parameter) => parameter.name),
        path,
      ).toEqual(['from', 'to', 'before', 'command', 'guild', 'user', 'outcome', 'limit']);
    }
  });
});

describe('image build', () => {
  it('copies every package manifest before installing, so the build step does not install a second time', () => {
    const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
    const beforeInstall = dockerfile.slice(0, dockerfile.indexOf('RUN pnpm install'));
    for (const dir of readdirSync(new URL('../../../packages/', import.meta.url))) {
      expect(beforeInstall).toContain(`COPY packages/${dir}/package.json packages/${dir}/`);
    }
  });
});

describe('rollup source', () => {
  const now = new Date('2026-11-14T15:20:00Z');

  it('starts reading at the bucket the range starts in', () => {
    expect(rollupSource(new Date('2026-11-14T14:20:30Z'), now)).toEqual({
      table: 'rollup_1h',
      from: new Date('2026-11-14T14:00:00Z'),
    });
    expect(rollupSource(new Date('2026-11-14T14:20:30Z'), now, true)).toEqual({
      table: 'rollup_1m',
      from: new Date('2026-11-14T14:20:00Z'),
    });
  });

  it('reads daily rollups, from the start of the day, past the 13 months hourly ones are kept', () => {
    expect(rollupSource(new Date('2025-06-01T09:30:00Z'), now)).toEqual({
      table: 'rollup_1d',
      from: new Date('2025-06-01T00:00:00Z'),
    });
  });
});

describe('job scheduler', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs a five-minute job every five minutes, however long the jobs take', async () => {
    vi.useFakeTimers();
    const statements: string[] = [];
    const errors: object[] = [];
    const db = {
      async query(sql: string) {
        statements.push(sql);
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { rows: [], rowCount: 0 };
      },
      connect: async () => ({
        on: () => undefined,
        release: () => undefined,
        query: async () => ({ rows: [{ ok: true }] }),
      }),
    } as unknown as Db;
    const jobs = startJobs(
      db,
      { info: () => undefined, error: (entry) => void errors.push(entry) },
      { settingsKey: Buffer.alloc(32, 1).toString('base64'), dashboardUrl: new URL('https://stats.example.com') },
    );

    await vi.advanceTimersByTimeAsync(10.5 * 60_000);
    // At 0, 5 and 10 minutes. Timed from when a run finished, the second would wait for the sixth minute.
    expect(statements.filter((sql) => sql.includes('FROM reports r'))).toHaveLength(3);
    expect(errors).toEqual([]);

    const stopped = jobs.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    await stopped;
  });

  it('keeps one connection, with one error listener, while another collector leads', async () => {
    vi.useFakeTimers();
    const clients: ReturnType<typeof fakeClient>[] = [];
    const db = {
      query: async () => ({ rows: [], rowCount: 0 }),
      connect: async () => {
        const c = fakeClient([{ ok: false }]);
        clients.push(c);
        return c.client;
      },
    } as unknown as Db;
    const jobs = startJobs(db, { info: () => undefined, error: () => undefined });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(clients).toHaveLength(1);
    expect(clients[0]?.client.listenerCount('error')).toBe(1);

    // A broken connection goes back to the pool to be destroyed, and the next attempt opens a new one.
    clients[0]?.client.emit('error', new Error('Connection terminated unexpectedly'));
    expect(clients[0]?.released).toEqual([true]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(clients).toHaveLength(2);
    await jobs.stop();
    expect(clients[1]?.released).toEqual([false]);
  });
});

describe('periods', () => {
  it('computes salt period bounds for months, ISO weeks and days', () => {
    expect(periodBounds('2026-11')).toMatchObject({
      start: Date.UTC(2026, 10, 1),
      end: Date.UTC(2026, 11, 1),
      period: 'month',
    });
    expect(periodBounds('2026-W46')).toMatchObject({ start: Date.UTC(2026, 10, 9), period: 'week' });
    expect(periodBounds('2026-W01')).toMatchObject({ start: Date.UTC(2025, 11, 29) });
    expect(periodBounds('2026-11-13')).toMatchObject({ start: Date.UTC(2026, 10, 13), period: 'day' });
    expect(periodBounds('2026-13')).toBeUndefined();
    expect(periodBounds('2026-W54')).toBeUndefined();
    expect(periodBounds("2026-11'; DROP TABLE x;--")).toBeUndefined();
  });

  it('only builds identifiers from valid labels', () => {
    expect(periodIdent('2026-W46')).toBe('2026_w46');
    expect(() => periodIdent('x"; DROP TABLE uniques; --')).toThrow();
  });

  it('parses user hashes', () => {
    expect(parseUserHash('h1:2026-11:9f3c1a0b6e2d4f7a8c5b1e3d2a4f6c8e')?.period).toBe('2026-11');
    expect(parseUserHash('112233445566778899')).toBeUndefined();
  });
});

describe('LiveHub tiles', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sums the last minute of interactions and 15 minutes of failures', () => {
    const hub = new LiveHub({} as never);
    const now = Date.now();
    hub.bump('1', now, 5, 1);
    hub.bump('1', now - 30_000, 3, 0);
    hub.bump('1', now - 90_000, 100, 2);
    hub.bump('1', now - 20 * 60_000, 50, 50);
    expect(hub.tiles('1', now)).toMatchObject({ perMinute: 8, errors15m: 3 });
    expect(hub.tiles('2', now)).toMatchObject({ perMinute: 0, errors15m: 0 });
  });

  it('keeps counting after 2038, when epoch seconds no longer fit 32 bits', () => {
    const hub = new LiveHub({} as never);
    const at = Date.UTC(2040, 0, 1);
    hub.bump('1', at, 5, 1);
    expect(hub.tiles('1', at)).toMatchObject({ perMinute: 5, errors15m: 1 });
  });

  it('gives a broken listening connection back to the pool, once', async () => {
    const { client, released } = fakeClient();
    const hub = new LiveHub({ connect: async () => client } as unknown as Db);
    expect(await hub.start()).toBe(true);
    client.emit('error', new Error('Connection terminated unexpectedly'));
    client.emit('error', new Error('Connection terminated unexpectedly'));
    await hub.stop();
    expect(released).toEqual([true]);
  });

  it('shares a burst spread over many seconds with the other instances', async () => {
    vi.useFakeTimers();
    const payloads: string[] = [];
    const db = {
      connect: async () => fakeClient().client,
      query: async (_sql: string, params: string[]) => {
        payloads.push(params[1] as string);
        return { rows: [] };
      },
    } as unknown as Db;
    const hub = new LiveHub(db);
    await hub.start();
    const now = Date.now();
    for (let back = 0; back < 900; back++) hub.bump('1', now - back * 1_000, 1 / 3, 1 / 3);
    await vi.advanceTimersByTimeAsync(1_000);
    await hub.stop();
    expect(payloads.length).toBeGreaterThan(1);
    for (const payload of payloads) expect(Buffer.byteLength(payload)).toBeLessThan(8_000);
    expect(payloads.flatMap((payload) => (JSON.parse(payload) as { c: unknown[] }).c)).toHaveLength(900);
  });
});

describe('live tiles stream', () => {
  it('keeps slots for other visitors when one opens too many streams', { timeout: 10_000 }, async () => {
    const db = { query: () => new Promise(() => undefined) } as unknown as Db;
    const config = loadConfig({ ...base, SHARDLENS_DEMO: 'true', SHARDLENS_TRUST_PROXY: '1', LOG_LEVEL: 'silent' });
    const app = await buildServer({ config, db, keys: new KeyStore(db), live: new LiveHub(db) });
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const aborted = new AbortController();
    const open = (visitor: string) =>
      fetch(`${address}/v1/live`, { signal: aborted.signal, headers: { 'x-forwarded-for': visitor } });
    try {
      for (let i = 0; i < 10; i++) expect((await open('198.51.100.1')).status).toBe(200);
      expect((await open('198.51.100.1')).status).toBe(503);
      expect((await open('198.51.100.2')).status).toBe(200);
    } finally {
      aborted.abort();
      await app.close();
    }
  });

  it('sends a heartbeat every 15 seconds, also while the database keeps updates from going out', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const db = { query: () => new Promise(() => undefined) } as unknown as Db;
    const config = loadConfig({ ...base, SHARDLENS_DEMO: 'true', LOG_LEVEL: 'silent' });
    const app = await buildServer({ config, db, keys: new KeyStore(db), live: new LiveHub(db) });
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const aborted = new AbortController();
    try {
      const res = await fetch(`${address}/v1/live`, { signal: aborted.signal });
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let text = decoder.decode((await reader.read()).value);
      expect(text).not.toContain('heartbeat');
      vi.advanceTimersByTime(15_000);
      while (!text.includes(': heartbeat\n\n')) text += decoder.decode((await reader.read()).value);
      expect(text).not.toContain('event: tiles');
    } finally {
      vi.useRealTimers();
      aborted.abort();
      await app.close();
    }
  });

  it(
    'ends open streams when the server closes, instead of waiting for them for ever',
    { timeout: 10_000 },
    async () => {
      const db = { query: async () => ({ rows: [] }) } as unknown as Db;
      const config = loadConfig({ ...base, SHARDLENS_DEMO: 'true', LOG_LEVEL: 'silent' });
      const app = await buildServer({ config, db, keys: new KeyStore(db), live: new LiveHub(db) });
      const address = await app.listen({ port: 0, host: '127.0.0.1' });
      const res = await fetch(`${address}/v1/live`);
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      await reader.read();
      const closed = app.close().then(() => 'closed');
      const late = new Promise((resolve) => setTimeout(resolve, 3_000, 'still open'));
      expect(await Promise.race([closed, late])).toBe('closed');
      let done = false;
      while (!done) ({ done } = await reader.read());
    },
  );

  it('waits for a slow database instead of starting another refresh every second', { timeout: 10_000 }, async () => {
    let queries = 0;
    const db = {
      query: () => {
        queries++;
        return new Promise(() => undefined);
      },
    } as unknown as Db;
    const config = loadConfig({ ...base, SHARDLENS_DEMO: 'true', LOG_LEVEL: 'silent' });
    const app = await buildServer({ config, db, keys: new KeyStore(db), live: new LiveHub(db) });
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const aborted = new AbortController();
    try {
      const res = await fetch(`${address}/v1/live`, { signal: aborted.signal });
      expect(res.status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      // One refresh (three queries) still waiting, not one started for every second.
      expect(queries).toBe(3);
    } finally {
      aborted.abort();
      await app.close();
    }
  });
});

describe('KeyStore', () => {
  const realKey = `slk_ingest_${'A'.repeat(43)}`;

  function store() {
    let lookups = 0;
    const db = {
      async query(sql: string, params: unknown[]) {
        if (!sql.startsWith('SELECT')) return { rows: [] };
        lookups++;
        const known = Buffer.isBuffer(params[0]) && params[0].equals(createHash('sha256').update(realKey).digest());
        return { rows: known ? [{ id: '1', app_id: '1234567890123456789', scope: 'ingest' }] : [] };
      },
    };
    return { keys: new KeyStore(db as unknown as Db), lookups: () => lookups };
  }

  it('looks a key up once a minute, whether it is known or not', async () => {
    const { keys, lookups } = store();
    expect(await keys.verify(realKey, 'ingest')).toMatchObject({ appId: '1234567890123456789' });
    expect(await keys.verify(realKey, 'ingest')).toBeDefined();
    const wrong = `slk_ingest_${'B'.repeat(43)}`;
    expect(await keys.verify(wrong, 'ingest')).toBeUndefined();
    expect(await keys.verify(wrong, 'ingest')).toBeUndefined();
    expect(lookups()).toBe(2);
  });

  it('never looks up a malformed key or one of the wrong scope', async () => {
    const { keys, lookups } = store();
    expect(await keys.verify('not-a-key', 'ingest')).toBeUndefined();
    expect(await keys.verify(realKey, 'read')).toBeUndefined();
    expect(await keys.verify(undefined, 'ingest')).toBeUndefined();
    expect(lookups()).toBe(0);
  });

  it('accepts a key of any of the scopes asked for, and of no other', async () => {
    const { keys, lookups } = store();
    expect(await keys.verify(realKey, ['read', 'ingest'])).toMatchObject({ scope: 'ingest' });
    expect(await keys.verify(realKey, ['read', 'activity'])).toBeUndefined();
    expect(await keys.verify(`slk_activity_${'A'.repeat(43)}`, ['read', 'ingest'])).toBeUndefined();
    expect(lookups()).toBe(1);
  });

  it('keeps real keys cached through a flood of made-up ones', async () => {
    const { keys, lookups } = store();
    await keys.verify(realKey, 'ingest');
    for (let i = 0; i < 2_500; i++) {
      await keys.verify(`slk_ingest_${String(i).padStart(43, 'C')}`, 'ingest');
    }
    const before = lookups();
    expect(await keys.verify(realKey, 'ingest')).toBeDefined();
    expect(lookups()).toBe(before);
  });
});

describe('rate-limit key', () => {
  it('is the client address, and still a string when the client has already disconnected', () => {
    expect(clientKey({ ip: '203.0.113.7' })).toBe('203.0.113.7');
    expect(clientKey({ ip: undefined as unknown as string })).toBe('disconnected');
  });
});
