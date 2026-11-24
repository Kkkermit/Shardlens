import { uuidv7 } from '@shardlens/core';
import { ClickHouseContainer, type StartedClickHouseContainer } from '@testcontainers/clickhouse';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runRollups } from '../src/jobs/rollups.js';
import { runQuery } from '../src/query/run.js';
import { QuerySpec } from '../src/query/spec.js';
import { ClickHouseStore } from '../src/storage/clickhouse.js';
import { APP_ID, envelope, type Harness, ingest, interaction, sdkHasher, startHarness } from './harness.js';

const GUILD_A = '112233445566778899';
const GUILD_B = '223344556677889900';

let clickhouse: StartedClickHouseContainer;
let store: ClickHouseStore;
let h: Harness;
let hashOf: (id: string) => Promise<string>;
const start = Date.now();
/** Set after ClickHouse starts mirroring: ClickHouse answers ranges from then on. */
let mirroredFrom = 0;
const range = () => ({ from: new Date(mirroredFrom).toISOString(), to: new Date(Date.now() + 120_000).toISOString() });
/** PostgreSQL's hourly rollups need an hour-aligned start to include this hour. */
const pgRange = () => ({
  from: new Date(Math.floor(mirroredFrom / 3_600_000) * 3_600_000).toISOString(),
  to: new Date(Date.now() + 3_600_000).toISOString(),
});
const run = (spec: object, withClickHouse: boolean) =>
  runQuery(h.store, APP_ID, QuerySpec.parse(spec), new Date(), withClickHouse ? store : undefined) as Promise<
    Record<string, unknown>
  >;

beforeAll(async () => {
  clickhouse = await new ClickHouseContainer(
    process.env.SHARDLENS_TEST_CH_IMAGE ?? 'clickhouse/clickhouse-server:26.8-alpine',
  )
    .withDatabase('shardlens')
    .start();
  store = new ClickHouseStore(clickhouse.getConnectionUrl());
  await store.migrate();
  mirroredFrom = Date.now();
  h = await startHarness({ analytics: store });
  const { hasher, period } = await sdkHasher(h.app);
  hashOf = async (id) => (await hasher.hash(id, period)) as string;

  const now = Date.now();
  const events = [
    interaction(await hashOf('300000000000000001'), { command: 'ticket', ackMs: 100, ts: now, id: uuidv7(now) }),
    interaction(await hashOf('300000000000000002'), { command: 'ticket', ackMs: 300, ts: now, id: uuidv7(now) }),
    interaction(await hashOf('300000000000000003'), {
      command: 'help',
      guild: GUILD_B,
      locale: 'de',
      outcome: 'error',
      ackMs: 2_500,
      ts: now,
      id: uuidv7(now),
    }),
    // A button: not part of the `interactions` metric (commands, context menus, entry points, message commands).
    interaction(await hashOf('300000000000000001'), {
      kind: 'button',
      command: undefined,
      sub: undefined,
      customId: 'ticket:close:*',
      componentType: 2,
      ts: now,
      id: uuidv7(now),
    }),
    {
      id: uuidv7(now),
      ts: now,
      type: 'custom',
      name: 'ticket_opened',
      props: {},
      user: await hashOf('300000000000000001'),
      guild: GUILD_A,
    },
  ];
  const first = await ingest(h.app, envelope(events));
  expect(first.json()).toMatchObject({ rejected: [] });
  // A retried batch: PostgreSQL ignores the duplicates, and they must not reach ClickHouse either.
  const retry = await ingest(h.app, envelope(events));
  expect(retry.json()).toMatchObject({ accepted: 0, duplicates: events.length });
  await store.flush();
  await runRollups(h.db, new Date(Date.now() + 120_000));
}, 300_000);

afterAll(async () => {
  await h?.close();
  await store?.stop();
  await clickhouse?.stop();
});

describe('ClickHouse analytics store (preview)', () => {
  it('answers chart queries with the same counts as PostgreSQL, without counting retries twice', async () => {
    const spec = { kind: 'top', metric: 'interactions', groupBy: 'command' };
    const fromPg = (await run({ ...spec, range: pgRange() }, false)).rows as { key: string; count: number }[];
    const fromCh = (await run({ ...spec, range: range() }, true)).rows as { key: string; count: number }[];
    const counts = (rows: { key: string; count: number }[]) => Object.fromEntries(rows.map((r) => [r.key, r.count]));
    expect(counts(fromCh)).toEqual({ ticket: 2, help: 1 });
    expect(counts(fromCh)).toEqual(counts(fromPg));
  });

  it('serves series from ClickHouse, decoding coded dimensions the same way', async () => {
    const spec = { kind: 'series', metric: 'interactions', range: range(), interval: 'hour', groupBy: 'outcome' };
    const result = await run(spec, true);
    expect(result.source).toBe('clickhouse');
    const total = Object.fromEntries((result.points as { key: string; value: number }[]).map((p) => [p.key, p.value]));
    expect(total).toEqual({ ok: 2, error: 1 });
  });

  it('handles per-server and filtered queries, and percentiles', async () => {
    const byGuild = (await run({ kind: 'top', metric: 'interactions', range: range(), groupBy: 'guild' }, true))
      .rows as { key: string; count: number }[];
    expect(Object.fromEntries(byGuild.map((r) => [r.key, r.count]))).toEqual({ [GUILD_A]: 2, [GUILD_B]: 1 });

    const german = (
      await run(
        {
          kind: 'top',
          metric: 'interactions',
          range: range(),
          groupBy: 'command',
          filters: [{ field: 'locale', value: 'de' }],
        },
        true,
      )
    ).rows as { key: string }[];
    expect(german.map((r) => r.key)).toEqual(['help']);

    const p95 = (
      await run({ kind: 'top', metric: 'interactions', range: range(), groupBy: 'command', stat: 'p95' }, true)
    ).rows as { key: string; value: number }[];
    expect(p95.find((r) => r.key === 'help')?.value).toBeGreaterThan(2_000);
  });

  it('counts custom events', async () => {
    const result = await run(
      { kind: 'series', metric: 'custom', name: 'ticket_opened', range: range(), interval: 'day' },
      true,
    );
    expect(result.source).toBe('clickhouse');
    expect((result.points as { value: number }[]).reduce((n, p) => n + p.value, 0)).toBe(1);
  });

  it('falls back to PostgreSQL for ranges that start before ClickHouse was enabled', async () => {
    const older = { from: new Date(start - 7 * 86_400_000).toISOString(), to: range().to };
    const result = await run({ kind: 'series', metric: 'interactions', range: older, interval: 'day' }, true);
    expect(result.source).toBeUndefined();
  });

  it('erases a person from ClickHouse too', async () => {
    const hash = await hashOf('300000000000000001');
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/privacy/erase',
      headers: { authorization: `Bearer slk_ingest_${'A'.repeat(43)}` },
      payload: { userHashes: [hash] },
    });
    expect(res.statusCode).toBe(200);
    const client = (await import('@clickhouse/client')).createClient({ url: clickhouse.getConnectionUrl() });
    const rows = await client.query({
      query: 'SELECT count() AS n FROM interactions WHERE user_hash = {h:String}',
      query_params: { h: Buffer.from(hash.split(':')[2] as string, 'hex').toString('hex') },
      format: 'JSONEachRow',
    });
    expect(Number(((await rows.json()) as { n: string | number }[])[0]?.n)).toBe(0);
    await client.close();
  });
  // Last, because it adds a run the tests above don't count.
  it('counts message (prefix) commands with interactions, like PostgreSQL does', async () => {
    const now = Date.now();
    const res = await ingest(
      h.app,
      envelope([
        {
          id: uuidv7(now),
          ts: now,
          type: 'message_command',
          command: 'warn',
          guild: GUILD_A,
          user: await hashOf('300000000000000004'),
          outcome: 'ok',
        },
      ]),
    );
    expect(res.json()).toMatchObject({ accepted: 1, rejected: [] });
    await store.flush();
    await runRollups(h.db, new Date(Date.now() + 120_000));
    const spec = {
      kind: 'top',
      metric: 'interactions',
      groupBy: 'kind',
      filters: [{ field: 'command', value: 'warn' }],
    };
    const fromCh = await run({ ...spec, range: range() }, true);
    const fromPg = await run({ ...spec, range: pgRange() }, false);
    expect(fromCh.rows).toEqual([expect.objectContaining({ key: 'message_command', count: 1 })]);
    expect(fromPg.rows).toEqual([expect.objectContaining({ key: 'message_command', count: 1 })]);
  });
});
