import type { AddressInfo } from 'node:net';
import {
  type ActivityLogPage,
  type ActivityTopUsers,
  createShardlensClient,
  ShardlensClientError,
} from '@shardlens/client';
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { seedKey } from '../src/security/auth.js';
import { APP_ID, envelope, type Harness, ingest, interaction, READ_KEY, sdkHasher, startHarness } from './harness.js';

// Who ran what, read the way a dashboard of the owner's own reads it: the real client, a real activity key, a real
// collector. As in client.int.test.ts, each schema is checked by `tsc` to be the client's own type and every answer
// is parsed with it strictly.

const Row = z.strictObject({
  interactionId: z.uuid(),
  ts: z.iso.datetime(),
  guildId: z.string().nullable(),
  guildName: z.string().nullable(),
  kind: z.string(),
  command: z.string().nullable(),
  sub: z.string().nullable(),
  customId: z.string().nullable(),
  outcome: z.enum(['ok', 'error', 'timeout', 'no_response']),
  ackMs: z.number().nullable(),
  userId: z.string().nullable(),
  username: z.string().nullable(),
  avatar: z.string().nullable(),
});
const Page = z.strictObject({ rows: z.array(Row), nextBefore: z.string().nullable() });
const TopUsers = z.strictObject({
  window: z.enum(['24h', '7d']),
  rows: z.array(z.strictObject({ userId: z.string().nullable(), runs: z.number() })),
});

const ACTIVITY_KEY = `slk_activity_${'D'.repeat(43)}`;
const GUILD = '112233445566778899';
const [ALICE, BOB] = ['300000000000000001', '300000000000000002'] as const;

let h: Harness;
let url: string;
const withKey = (key: string) => createShardlensClient({ endpoint: url, apiKey: key });

async function refusal(call: Promise<unknown>): Promise<ShardlensClientError> {
  const error = await call.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ShardlensClientError);
  return error as ShardlensClientError;
}

beforeAll(async () => {
  h = await startHarness({ auditKey: Buffer.alloc(32, 9).toString('base64') });
  await seedKey(h.store, APP_ID, ACTIVITY_KEY, 'my dashboard');
  await h.app.listen({ port: 0, host: '127.0.0.1' });
  url = `http://127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await h?.close();
});

describe('the activity log through @shardlens/client', () => {
  it('declares the types its answers are checked against', () => {
    expectTypeOf<z.infer<typeof Page>>().toEqualTypeOf<ActivityLogPage>();
    expectTypeOf<z.infer<typeof TopUsers>>().toEqualTypeOf<ActivityTopUsers>();
  });

  it('says the collector is not in audit mode while users are hashed', async () => {
    const client = withKey(ACTIVITY_KEY);
    expect(await refusal(client.activity.log())).toMatchObject({ status: 404, code: 'audit_mode_off' });
    expect(await refusal(client.activity.topUsers())).toMatchObject({ status: 404, code: 'audit_mode_off' });
    // The numbers are there in either mode, with the same key.
    expect(await client.meta()).toMatchObject({ appId: APP_ID, mode: 'privacy' });
  });

  it('reads who ran what with an activity key: filtered, page by page, and counted', async () => {
    await h.db.query("UPDATE apps SET mode = 'audit' WHERE app_id = $1", [APP_ID]);
    const { hasher, period } = await sdkHasher(h.app);
    const now = Date.now();
    const run = async (userId: string, username: string, secondsAgo: number, overrides: Record<string, unknown>) =>
      interaction((await hasher.hash(userId, period)) as string, {
        guild: GUILD,
        ts: now - secondsAgo * 1000,
        actor: { userId, username },
        ...overrides,
      });
    const runs = [
      await run(ALICE, 'alice', 4, { command: 'ticket', outcome: 'ok' }),
      await run(ALICE, 'alice', 3, { command: 'ticket', outcome: 'error' }),
      await run(BOB, 'bob', 2, { command: 'ban', outcome: 'timeout' }),
      await run(BOB, 'bob', 1, { command: 'ban', outcome: 'ok' }),
    ];
    expect((await ingest(h.app, envelope(runs, { mode: 'audit' }))).json()).toMatchObject({ accepted: 4 });

    const client = withKey(ACTIVITY_KEY);
    const all = await client.activity.log();
    expect(Page.safeParse(all).error?.issues).toBeUndefined();
    expect(all.rows.map((row) => [row.userId, row.username, row.command, row.outcome])).toEqual([
      [BOB, 'bob', 'ban', 'ok'],
      [BOB, 'bob', 'ban', 'timeout'],
      [ALICE, 'alice', 'ticket', 'error'],
      [ALICE, 'alice', 'ticket', 'ok'],
    ]);
    expect(all.nextBefore).toBeNull();

    const first = await client.activity.log({ limit: 3 });
    expect(first.rows.map((row) => row.interactionId)).toEqual(all.rows.slice(0, 3).map((row) => row.interactionId));
    const second = await client.activity.log({ limit: 3, before: first.nextBefore ?? undefined });
    expect(second.rows.map((row) => row.interactionId)).toEqual([all.rows[3]?.interactionId]);
    expect(second.nextBefore).toBeNull();

    const failed = await client.activity.log({ guild: GUILD, outcome: 'failed' });
    expect(failed.rows.map((row) => row.outcome)).toEqual(['timeout', 'error']);
    const alice = await client.activity.log({ user: ALICE, command: 'ticket' });
    expect(alice.rows.map((row) => row.userId)).toEqual([ALICE, ALICE]);
    expect((await client.activity.log({ guild: '998877665544332211' })).rows).toEqual([]);

    const top = await client.activity.topUsers('7d');
    expect(TopUsers.safeParse(top).error?.issues).toBeUndefined();
    expect(top.window).toBe('7d');
    expect(top.rows).toHaveLength(2);
    expect(top.rows).toEqual(
      expect.arrayContaining([
        { userId: ALICE, runs: 2 },
        { userId: BOB, runs: 2 },
      ]),
    );

    // One key for a whole dashboard: the same client asks for the numbers.
    expect((await client.meta()).mode).toBe('audit');
    expect((await client.overview()).app).toMatchObject({ id: APP_ID, mode: 'audit' });
  });

  it('tells a read key which key the log needs, and refuses a key it does not know', async () => {
    const reader = withKey(READ_KEY);
    expect(await refusal(reader.activity.log())).toMatchObject({ status: 403, code: 'activity_key_required' });
    expect(await refusal(reader.activity.topUsers())).toMatchObject({ status: 403, code: 'activity_key_required' });
    const unknown = withKey(`slk_activity_${'x'.repeat(43)}`);
    expect(await refusal(unknown.activity.log())).toMatchObject({ status: 401, code: 'unauthorized' });
  });
});
