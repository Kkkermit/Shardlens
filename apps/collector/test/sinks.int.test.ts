import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { uuidv7 } from '@shardlens/core';
import { MariaDbContainer } from '@testcontainers/mariadb';
import { MongoDBContainer } from '@testcontainers/mongodb';
import { MySqlContainer } from '@testcontainers/mysql';
import type { FastifyInstance } from 'fastify';
import { MongoClient } from 'mongodb';
import { createConnection } from 'mysql2/promise';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KeyStore } from '../src/security/auth.js';
import { buildServer } from '../src/server.js';
import { createSink, SinkMirror } from '../src/storage/sink.js';
import {
  envelope,
  guildInfo,
  type Harness,
  INGEST_KEY,
  ingest,
  interaction,
  sdkHasher,
  startHarness,
} from './harness.js';

const GUILD = '112233445566778899';

/** Reads a sink's table back with the database's own client, to check what really landed. */
interface Reader {
  count(userHash?: string): Promise<number>;
  command(id: string): Promise<string | null>;
  close(): Promise<void>;
}

interface Target {
  name: string;
  url: () => string;
  reader: () => Promise<Reader>;
}

let h: Harness;
const dir = mkdtempSync(join(tmpdir(), 'shardlens-sinks-'));
const containers: { stop(): Promise<unknown> }[] = [];

function sqlReader(
  query: (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>,
  close: () => Promise<void>,
  p: (i: number) => string,
): Reader {
  return {
    async count(userHash) {
      const rows = userHash
        ? await query(`SELECT count(*) AS n FROM shardlens_events WHERE user_hash = ${p(1)}`, [userHash])
        : await query('SELECT count(*) AS n FROM shardlens_events', []);
      return Number(rows[0]?.n);
    },
    async command(id) {
      const rows = await query(`SELECT data FROM shardlens_events WHERE id = ${p(1)}`, [id]);
      const data = rows[0]?.data;
      const parsed = (typeof data === 'string' ? JSON.parse(data) : data) as { command?: string } | undefined;
      return parsed?.command ?? null;
    },
    close,
  };
}

const targets: Target[] = [];

beforeAll(async () => {
  h = await startHarness();
  const mongo = await new MongoDBContainer(process.env.SHARDLENS_TEST_MONGO_IMAGE ?? 'mongo:8.0').start();
  const mysql = await new MySqlContainer(process.env.SHARDLENS_TEST_MYSQL_IMAGE ?? 'mysql:8.4').start();
  const maria = await new MariaDbContainer(process.env.SHARDLENS_TEST_MARIADB_IMAGE ?? 'mariadb:11.4').start();
  containers.push(mongo, mysql, maria);
  await h.db.query('CREATE DATABASE bot_data');
  const pgUrl = h.config.databaseUrl.replace(/\/[^/]+$/, '/bot_data');
  const sqliteFile = join(dir, 'events.db');
  const mongoUrl = `${mongo.getConnectionString()}/mybot?directConnection=true`;

  targets.push(
    {
      name: 'MongoDB',
      url: () => mongoUrl,
      reader: async () => {
        const client = await new MongoClient(mongoUrl).connect();
        const c = client.db('mybot').collection<{ _id: string; command?: string }>('shardlens_events');
        return {
          count: (userHash) => c.countDocuments(userHash ? { userHash } : {}),
          command: async (id) => (await c.findOne({ _id: id }))?.command ?? null,
          close: () => client.close(),
        };
      },
    },
    ...[
      ['MySQL', mysql.getConnectionUri()],
      ['MariaDB', maria.getConnectionUri().replace(/^mysql:/, 'mariadb:')],
    ].map(([name, url]) => ({
      name: name as string,
      url: () => url as string,
      reader: async () => {
        const conn = await createConnection((url as string).replace(/^mariadb:/, 'mysql:'));
        return sqlReader(
          async (sql, params) => (await conn.query(sql, params))[0] as Record<string, unknown>[],
          () => conn.end(),
          () => '?',
        );
      },
    })),
    {
      name: 'PostgreSQL',
      url: () => pgUrl,
      reader: async () => {
        const client = new pg.Client({ connectionString: pgUrl });
        await client.connect();
        return sqlReader(
          async (sql, params) => (await client.query(sql, params)).rows,
          () => client.end(),
          (i) => `$${i}`,
        );
      },
    },
    {
      name: 'SQLite',
      url: () => `sqlite:${sqliteFile}`,
      reader: async () => {
        const db = new DatabaseSync(sqliteFile);
        return sqlReader(
          async (sql, params) => db.prepare(sql).all(...(params as string[])) as Record<string, unknown>[],
          async () => db.close(),
          () => '?',
        );
      },
    },
  );
}, 300_000);

afterAll(async () => {
  await h?.close();
  await Promise.all(containers.map((c) => c.stop()));
  rmSync(dir, { recursive: true, force: true });
});

describe.each(['MongoDB', 'MySQL', 'MariaDB', 'PostgreSQL', 'SQLite'])('%s sink', (name) => {
  let app: FastifyInstance;
  let mirror: SinkMirror;
  let reader: Reader;

  beforeAll(async () => {
    const target = targets.find((t) => t.name === name) as Target;
    mirror = new SinkMirror(await createSink(target.url()));
    app = await buildServer({
      config: h.config,
      store: h.store,
      db: h.db,
      keys: new KeyStore(h.store),
      live: h.live,
      sink: mirror,
    });
    await app.ready();
    reader = await target.reader();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await mirror?.stop();
    await reader?.close();
  });

  it('receives every accepted event once, and a person’s copies are erased with them', async () => {
    const { hasher, period } = await sdkHasher(app);
    const alice = (await hasher.hash('400000000000000001', period)) as string;
    const bob = (await hasher.hash('400000000000000002', period)) as string;
    const prefix = {
      id: uuidv7(),
      ts: Date.now(),
      type: 'message_command',
      command: 'ban',
      guild: GUILD,
      user: alice,
      outcome: 'ok',
    };
    const events = [
      prefix,
      interaction(bob, { command: 'ticket' }),
      { id: uuidv7(), ts: Date.now(), type: 'custom', name: 'ticket_opened', props: {}, user: alice },
      {
        id: uuidv7(),
        ts: Date.now(),
        type: 'guild_join',
        info: guildInfo(snowflake()),
        detectedAtStartup: false,
      },
    ];
    expect((await ingest(app, envelope(events))).json()).toMatchObject({ accepted: 4, rejected: [] });
    // The SDK retries a batch it never got an answer for: stored once in PostgreSQL and in the sink.
    expect((await ingest(app, envelope(events))).json()).toMatchObject({ accepted: 0, duplicates: 4 });
    await mirror.flush();
    expect(await reader.count()).toBe(4);
    expect(await reader.command(prefix.id)).toBe('ban');

    const aliceHex = alice.split(':')[2] as string;
    expect(await reader.count(aliceHex)).toBe(2);
    const erase = await app.inject({
      method: 'POST',
      url: '/v1/privacy/erase',
      headers: { authorization: `Bearer ${INGEST_KEY}` },
      payload: { userHashes: [alice] },
    });
    expect(erase.statusCode).toBe(200);
    expect(await reader.count(aliceHex)).toBe(0);
    expect(await reader.count()).toBe(2);
    // Nothing but hashes: the raw user IDs never reach the sink.
    expect(await reader.count('400000000000000002')).toBe(0);
  });

  it('expires copies past their retention', async () => {
    expect(await mirror.expire(new Date(Date.now() + 36 * 86_400_000))).toBe(2);
    expect(await reader.count()).toBe(0);
  });
});

let seq = 0;
function snowflake(): string {
  return String(500000000000000000n + BigInt(++seq) * 1_000_000n);
}
