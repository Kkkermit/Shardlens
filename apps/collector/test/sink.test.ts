import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { uuidv7 } from '@shardlens/core';
import { COLLECTED_FIELDS, type Event, Event as EventSchema } from '@shardlens/schema';
import { afterAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { loadConfig } from '../src/env.js';
import {
  createSink,
  type EventSink,
  SinkMirror,
  type StoredEvent,
  toStoredEvent,
  withoutCredentials,
} from '../src/storage/sink.js';

const APP = '1234567890123456789';
const GUILD = '112233445566778899';
const HEX = '9f3c1a0b6e2d4f7a8c5b1e3d2a4f6c8e';
const OTHER = '0123456789abcdef0123456789abcdef';
const ctx = { appId: APP, env: 'production', release: '2.4.4' };
const dir = mkdtempSync(join(tmpdir(), 'shardlens-sink-'));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function command(user = HEX, overrides: Record<string, unknown> = {}): Event {
  return {
    id: uuidv7(),
    ts: Date.now(),
    weight: 1,
    type: 'message_command',
    command: 'ban',
    options: [],
    guild: GUILD,
    user: `h1:2026-11:${user}`,
    outcome: 'ok',
    ...overrides,
  } as Event;
}

/** A sink that remembers what it was given, and can be told to fail. */
function memorySink() {
  const rows = new Map<string, StoredEvent>();
  const state = { failWrites: 0, failInit: false, inits: 0, erased: [] as string[][] };
  const sink: EventSink = {
    name: 'memory',
    async init() {
      state.inits++;
      if (state.failInit) throw new Error('connect ECONNREFUSED mongodb://admin:hunter2@db.internal:27017');
    },
    async write(events) {
      if (state.failWrites > 0) {
        state.failWrites--;
        throw new Error('write failed');
      }
      for (const e of events) rows.set(e.id, e);
    },
    async erase(_app, hashes) {
      state.erased.push([...hashes]);
      let n = 0;
      for (const [id, e] of rows) if (e.userHash && hashes.includes(e.userHash) && rows.delete(id)) n++;
      return n;
    },
    async expire(before) {
      let n = 0;
      for (const [id, e] of rows) if (e.ts < before && rows.delete(id)) n++;
      return n;
    },
    async close() {},
  };
  return { sink, rows, state };
}

describe('stored copies', () => {
  it('keep the hashed user and the server, and never an audit identity', () => {
    const stored = toStoredEvent(ctx, command(HEX, { actor: { userId: '334455667788990011', username: 'someone' } }));
    expect(stored).toMatchObject({ appId: APP, env: 'production', release: '2.4.4', type: 'message_command' });
    expect(stored).toMatchObject({ guildId: GUILD, userHash: HEX, saltPeriod: '2026-11' });
    expect(JSON.stringify(stored)).not.toContain('334455667788990011');
    expect(JSON.stringify(stored)).not.toContain('someone');

    const join = toStoredEvent(ctx, {
      id: uuidv7(),
      ts: Date.now(),
      weight: 1,
      type: 'guild_join',
      detectedAtStartup: false,
      info: { guild: GUILD },
    } as unknown as Event);
    expect(join).toMatchObject({ guildId: GUILD, userHash: null, saltPeriod: null });
  });

  it('never carry a field the data-collected register marks as identifying', () => {
    // Driven by the register, so a future identifying field is covered without touching this test.
    const types = new Set(EventSchema.options.map((o) => (o.shape.type as z.ZodLiteral<string>).value));
    const identifying = COLLECTED_FIELDS.filter((f) => f.personal === 'yes' && types.has(f.object));
    expect(identifying.map((f) => `${f.object}.${f.field}`)).toEqual(
      expect.arrayContaining(['interaction.actor', 'message_command.actor', 'app_info.dashboardUserIds']),
    );
    for (const field of identifying) {
      const event = {
        id: uuidv7(),
        ts: Date.now(),
        weight: 1,
        type: field.object,
        [field.field]: ['334455667788990011'],
      };
      const stored = toStoredEvent(ctx, event as unknown as Event);
      expect(stored.data, `${field.object}.${field.field}`).not.toHaveProperty(field.field);
      expect(JSON.stringify(stored)).not.toContain('334455667788990011');
    }
  });

  it('never log a password from a connection URL', () => {
    expect(withoutCredentials('failed: mongodb+srv://bot:s3cret@cluster0.example.net/db')).toBe(
      'failed: mongodb+srv://***@cluster0.example.net/db',
    );
    expect(withoutCredentials('mysql://root@localhost and postgres://u:p@h/db')).toBe(
      'mysql://***@localhost and postgres://***@h/db',
    );
  });
});

describe('SQLite sink', () => {
  it('stores each event once, erases a person and expires old copies', async () => {
    const file = join(dir, 'events.db');
    const sink = await createSink(`sqlite:${file}`, 'bot_events');
    await sink.init?.();
    const old = command(HEX, { ts: Date.now() - 40 * 86_400_000 });
    const batch = [toStoredEvent(ctx, command(HEX)), toStoredEvent(ctx, command(OTHER)), toStoredEvent(ctx, old)];
    await sink.write(batch);
    await sink.write(batch); // a retried batch
    const db = new DatabaseSync(file);
    const count = () => (db.prepare('SELECT count(*) AS n FROM bot_events').get() as { n: number }).n;
    expect(count()).toBe(3);
    const row = db
      .prepare(
        "SELECT type, guild_id, user_hash, json_extract(data, '$.command') AS command FROM bot_events WHERE id = ?",
      )
      .get(batch[1]?.id ?? '');
    expect({ ...row }).toEqual({ type: 'message_command', guild_id: GUILD, user_hash: OTHER, command: 'ban' });

    expect(await sink.erase(APP, [OTHER])).toBe(1);
    expect(await sink.expire(new Date(Date.now() - 35 * 86_400_000))).toBe(1);
    expect(count()).toBe(1);
    db.close();
    await sink.close();
  });

  it('expires a large backlog in chunks', async () => {
    const sink = await createSink(`sqlite:${join(dir, 'big.db')}`);
    await sink.init?.();
    const old = Date.now() - 400 * 86_400_000;
    for (let i = 0; i < 9; i++) {
      await sink.write(Array.from({ length: 500 }, () => toStoredEvent(ctx, command(HEX, { ts: old }))));
    }
    expect(await sink.expire(new Date(Date.now() - 35 * 86_400_000))).toBe(4_500);
    await sink.close();
  });

  it('refuses table names and URLs it does not know', async () => {
    await expect(createSink(`sqlite:${join(dir, 'x.db')}`, 'events; DROP TABLE x')).rejects.toThrow(/identifier/);
    // Long enough that `<table>_app_ts` would pass MySQL's 64-character limit.
    await expect(createSink(`sqlite:${join(dir, 'x.db')}`, 'a'.repeat(49))).rejects.toThrow(/identifier/);
    await expect(createSink('redis://localhost:6379')).rejects.toThrow(/must start with/);
  });
});

describe('sink mirror', () => {
  it('copies only the event types asked for', async () => {
    const { sink, rows } = memorySink();
    const mirror = new SinkMirror(sink, { events: ['custom'] });
    mirror.push(ctx, [command(), { ...command(), type: 'custom', name: 'ticket_opened', props: {} } as Event]);
    await mirror.flush();
    expect([...rows.values()].map((r) => r.type)).toEqual(['custom']);
  });

  it('keeps copies through a failed write and sends them on the next try', async () => {
    const { sink, rows, state } = memorySink();
    const warnings: string[] = [];
    const mirror = new SinkMirror(sink);
    mirror.start((m) => warnings.push(m));
    state.failWrites = 1;
    mirror.push(ctx, [command(), command()]);
    await mirror.flush();
    expect(rows.size).toBe(0);
    expect(warnings[0]).toMatch(/memory sink write failed/);
    await mirror.flush();
    expect(rows.size).toBe(2);
    expect(state.inits).toBe(2); // prepared again after the failure
    await mirror.stop();
  });

  it('starts while the database is down, retries later, and logs without the password', async () => {
    const { sink, rows, state } = memorySink();
    state.failInit = true;
    const warnings: string[] = [];
    const mirror = new SinkMirror(sink);
    mirror.start((m) => warnings.push(m));
    mirror.push(ctx, [command()]);
    await mirror.flush();
    expect(rows.size).toBe(0);
    expect(warnings.join('\n')).toContain('mongodb://***@db.internal');
    expect(warnings.join('\n')).not.toContain('hunter2');
    state.failInit = false;
    await mirror.flush();
    expect(rows.size).toBe(1);
    await mirror.stop();
  });

  it('drops only the rows the database keeps refusing, so one bad row never holds up the rest', async () => {
    const { sink, rows } = memorySink();
    const bad = command(HEX, { command: 'poison' });
    const write = sink.write.bind(sink);
    sink.write = async (events) => {
      if (events.some((e) => e.id === bad.id)) throw new Error('Data too long for column');
      await write(events);
    };
    const mirror = new SinkMirror(sink);
    mirror.push(ctx, [command(), bad, command()]);
    for (let i = 0; i < 3; i++) await mirror.flush();
    expect(rows.size).toBe(2);
    expect(rows.has(bad.id)).toBe(false);
    expect(mirror.dropped).toBe(1);
  });

  it('keeps everything while the database is down, however many times it fails', async () => {
    const { sink, rows, state } = memorySink();
    const mirror = new SinkMirror(sink);
    state.failInit = true;
    mirror.push(ctx, [command(), command()]);
    for (let i = 0; i < 5; i++) await mirror.flush();
    expect(mirror.dropped).toBe(0);
    state.failInit = false;
    await mirror.flush();
    expect(rows.size).toBe(2);
  });

  it('fails an erase while the database is unreachable, so the caller retries it', async () => {
    const { sink, state } = memorySink();
    state.failInit = true;
    const mirror = new SinkMirror(sink);
    await expect(mirror.erase(APP, [Buffer.from(HEX, 'hex')])).rejects.toThrow(/unreachable/);
    state.failInit = false;
    await expect(mirror.erase(APP, [Buffer.from(HEX, 'hex')])).resolves.toBe(0);
  });

  it('drops and counts copies once its buffer is full, without throwing', () => {
    const { sink } = memorySink();
    const mirror = new SinkMirror(sink);
    const many = Array.from({ length: 20_000 }, () => command());
    mirror.push(ctx, many);
    expect(() => mirror.push(ctx, [command(), command()])).not.toThrow();
    expect(mirror.dropped).toBe(2);
    expect(() => mirror.push(ctx, [null as unknown as Event])).not.toThrow();
  });

  it('erases a person from the sink and from copies still waiting to be written', async () => {
    const { sink, rows, state } = memorySink();
    const mirror = new SinkMirror(sink);
    mirror.push(ctx, [command(HEX)]);
    await mirror.flush();
    mirror.push(ctx, [command(HEX), command(OTHER)]);
    const erased = await mirror.erase(APP, [Buffer.from(HEX, 'hex')]);
    expect(erased).toBe(2); // one waiting, one already written
    expect(state.erased).toEqual([[HEX]]);
    await mirror.flush();
    expect([...rows.values()].map((r) => r.userHash)).toEqual([OTHER]);
  });

  it('counts only the copies it erased, while a flush writes the others', async () => {
    const { sink, rows } = memorySink();
    const mirror = new SinkMirror(sink);
    mirror.push(ctx, [...Array.from({ length: 1_000 }, () => command(OTHER)), command(HEX)]);
    const flushed = mirror.flush();
    expect(await mirror.erase(APP, [Buffer.from(HEX, 'hex')])).toBe(1);
    await flushed;
    expect(rows.size).toBe(1_000);
  });

  it('expires copies past their retention', async () => {
    const { sink, rows } = memorySink();
    const mirror = new SinkMirror(sink, { retentionDays: 7 });
    mirror.push(ctx, [command(HEX, { ts: Date.now() - 8 * 86_400_000 }), command(HEX)]);
    await mirror.flush();
    expect(await mirror.expire()).toBe(1);
    expect(rows.size).toBe(1);
  });
});

describe('sink settings', () => {
  const base = {
    DATABASE_URL: 'postgres://localhost/shardlens',
    SHARDLENS_PUBLIC_URL: 'https://stats.example.com',
    SHARDLENS_APP_ID: APP,
    SHARDLENS_SESSION_SECRET: 'x'.repeat(48),
    SHARDLENS_SETTINGS_KEY: Buffer.alloc(32, 1).toString('base64'),
  };

  it('are off unless a sink URL is set', () => {
    expect(loadConfig(base).sink).toBeUndefined();
  });

  it('read the URL, table, retention and event types', () => {
    const config = loadConfig({
      ...base,
      SHARDLENS_SINK_URL: 'mongodb+srv://bot:pw@cluster0.example.net/mybot',
      SHARDLENS_SINK_TABLE: 'analytics',
      SHARDLENS_SINK_RETENTION_DAYS: '400',
      SHARDLENS_SINK_EVENTS: 'interaction, message_command,custom',
    });
    expect(config.sink).toEqual({
      to: 'mongodb+srv://bot:pw@cluster0.example.net/mybot',
      table: 'analytics',
      retentionDays: 400,
      events: ['interaction', 'message_command', 'custom'],
    });
  });

  it('refuse an unknown database, and never print the URL', () => {
    let message = '';
    try {
      loadConfig({ ...base, SHARDLENS_SINK_URL: 'redis://user:topsecret@cache:6379' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/SHARDLENS_SINK_URL/);
    expect(message).not.toContain('topsecret');
    expect(() => loadConfig({ ...base, SHARDLENS_SINK_URL: 'sqlite:x.db', SHARDLENS_SINK_TABLE: 'a-b' })).toThrow(
      /SHARDLENS_SINK_TABLE/,
    );
  });
});
