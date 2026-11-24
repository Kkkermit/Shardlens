import { uuidv7 } from '@shardlens/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runRollups, runUniques } from '../src/jobs/rollups.js';
import { APP_ID, envelope, type Harness, ingest, interaction, query, sdkHasher, startHarness } from './harness.js';

const GUILD = '112233445566778899';

function messageCommand(user: string, overrides: Record<string, unknown> = {}) {
  return {
    id: uuidv7(),
    ts: Date.now(),
    type: 'message_command',
    command: 'ban',
    options: ['user'],
    guild: GUILD,
    channelType: 0,
    memberTier: 'manager',
    user,
    outcome: 'ok',
    handlerMs: 30,
    ...overrides,
  };
}

let h: Harness;

beforeAll(async () => {
  h = await startHarness();
  const { hasher, period } = await sdkHasher(h.app);
  const users = await Promise.all([1n, 2n, 3n].map((n) => hasher.hash(String(700000000000000000n + n), period)));
  const [a, b, c] = users as [string, string, string];
  const res = await ingest(
    h.app,
    envelope([
      // `ban` runs both ways: twice as a slash command (one missed the deadline) and three times as a prefix command.
      interaction(a, { command: 'ban', sub: undefined, deferred: true }),
      interaction(b, { command: 'ban', sub: undefined, outcome: 'timeout', ackMs: undefined }),
      messageCommand(a),
      messageCommand(b, { outcome: 'error', errorClass: 'TypeError' }),
      messageCommand(c, { guild: undefined, memberTier: 'dm', channelType: 1 }),
    ]),
  );
  expect(res.json()).toMatchObject({ accepted: 5, rejected: [] });
  await runRollups(h.db, new Date());
  await runUniques(h.db);
});

afterAll(async () => {
  await h?.close();
});

const range = () => ({
  from: new Date(Date.now() - 86_400_000).toISOString(),
  to: new Date(Date.now() + 3_600_000).toISOString(),
});

describe('message (prefix) commands', () => {
  it('stores them with interactions, with no language, install type, entitlement or response', async () => {
    const rows = await h.db.query(
      `SELECT context, install, locale, premium, ack_ms, guild_id::text AS guild, member_tier
         FROM interactions WHERE kind = 9 ORDER BY guild_id NULLS LAST`,
    );
    expect(rows.rows).toEqual([
      { context: 0, install: null, locale: '', premium: false, ack_ms: null, guild: GUILD, member_tier: 2 },
      { context: 0, install: null, locale: '', premium: false, ack_ms: null, guild: GUILD, member_tier: 2 },
      { context: 1, install: null, locale: '', premium: false, ack_ms: null, guild: null, member_tier: 0 },
    ]);
  });

  it('counts both surfaces in the command list, with failures and unique users', async () => {
    const res = await query(h.app, { kind: 'commands', range: range() });
    const ban = (
      res.json().rows as { command: string; runs: number; errorRate: number; servers: number; kinds: string[] }[]
    ).find((r) => r.command === 'ban');
    // The kinds tell the dashboard how to write the name: `/ban` and `ban` are both this command.
    expect(ban).toMatchObject({ runs: 5, servers: 1, kinds: ['chat_input', 'message_command'] });
    // One prefix error and one missed deadline.
    expect(ban?.errorRate).toBeCloseTo(2 / 5);

    const byKind = await query(h.app, { kind: 'top', metric: 'interactions', range: range(), groupBy: 'kind' });
    expect(byKind.json().rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'chat_input', count: 2 }),
        expect.objectContaining({ key: 'message_command', count: 3 }),
      ]),
    );
    const users = await h.db.query(
      "SELECT count(DISTINCT user_hash)::int AS n FROM uniques WHERE scope = 'command' AND scope_key = 'ban'",
    );
    expect(users.rows[0].n).toBe(3);
  });

  it('leaves them out of deadline, response and premium figures, which only interactions have', async () => {
    const reliability = (await query(h.app, { kind: 'reliability', range: range() })).json();
    expect(reliability.totals).toMatchObject({ runs: 2, missedDeadlines: 1 });
    expect(await h.store.alerts.metricValue(APP_ID, 'missed_deadline_rate', 3_600)).toBeCloseTo(50);
    // The error rate is about every command, prefix ones included: one timeout and one prefix error of five.
    expect(await h.store.alerts.metricValue(APP_ID, 'error_rate', 3_600)).toBeCloseTo(40);

    const detail = (await query(h.app, { kind: 'command', name: 'ban', range: range() })).json();
    // Shares count the 2 interactions only: 1 deferred, neither by a premium user.
    expect(detail.totals).toMatchObject({ runs: 5, deferRate: 0.5, premiumShare: 0 });
    expect(detail.kinds).toEqual([
      { key: 'message_command', value: 3 },
      { key: 'chat_input', value: 2 },
    ]);
    expect(detail.locales).toEqual([{ key: 'en-GB', value: 2 }]);

    const audience = (await query(h.app, { kind: 'audience', range: range() })).json();
    expect(JSON.stringify(audience)).not.toMatch(/"key":(""|null)/);
  });
});
