import { describe, expect, it } from 'vitest';
import { type ActivityRow, ShardlensClientError } from '../src/index.js';
import { ACTIVITY_KEY, clientFor, rejection } from './helpers.js';

const USER = '334455667788990011';
const GUILD = '112233445566778899';

function row(n: number): ActivityRow {
  return {
    interactionId: `0193f0c0-0000-7000-8000-00000000000${n}`,
    ts: `2026-11-16T10:00:0${n}.000Z`,
    guildId: GUILD,
    guildName: 'Pixel Pals',
    kind: 'chat_input',
    command: 'ticket',
    sub: 'open',
    customId: null,
    outcome: 'error',
    ackMs: 120,
    userId: USER,
    username: 'ada',
    avatar: null,
  };
}

describe('activity.log', () => {
  it('reads /v1/audit/log with a GET and the key as a bearer token', async () => {
    const page = { rows: [row(1)], nextBefore: null };
    const { client, asked } = clientFor(() => Response.json(page), { apiKey: ACTIVITY_KEY });
    await expect(client.activity.log()).resolves.toEqual(page);
    expect(asked[0]).toMatchObject({ method: 'GET', path: '/v1/audit/log', body: undefined });
    expect(asked[0]?.headers.get('authorization')).toBe(`Bearer ${ACTIVITY_KEY}`);
  });

  it('puts every filter in the query string, the user ID included', async () => {
    const { client, asked } = clientFor(() => Response.json({ rows: [], nextBefore: null }));
    await client.activity.log({
      guild: GUILD,
      command: 'ticket',
      user: USER,
      outcome: 'failed',
      before: '2026-11-16T10:00:00.000Z',
      from: '2026-11-01T00:00:00+01:00',
      to: '2026-11-16T12:00:00Z',
      limit: 200,
    });
    expect(asked[0]?.url.pathname).toBe('/v1/audit/log');
    expect(Object.fromEntries(asked[0]?.url.searchParams ?? [])).toEqual({
      guild: GUILD,
      command: 'ticket',
      user: USER,
      outcome: 'failed',
      before: '2026-11-16T10:00:00.000Z',
      from: '2026-11-01T00:00:00+01:00',
      to: '2026-11-16T12:00:00Z',
      limit: '200',
    });
    expect(asked[0]?.url.search).toContain(`user=${USER}`);
    // An offset's plus sign must reach the collector as a plus, not as the space a bare `+` stands for.
    expect(asked[0]?.url.search).toContain('from=2026-11-01T00%3A00%3A00%2B01%3A00');
  });

  it('leaves out the filters that are not set', async () => {
    const { client, asked } = clientFor(() => Response.json({ rows: [], nextBefore: null }));
    await client.activity.log({ command: 'help', guild: undefined, before: null });
    expect(asked[0]?.path).toBe('/v1/audit/log?command=help');
  });

  it('pages back through the log with nextBefore', async () => {
    const cursors = [
      '2026-11-16T10:00:03.000Z~0193f0c0-0000-7000-8000-000000000003',
      '2026-11-16T10:00:01.000Z~0193f0c0-0000-7000-8000-000000000001',
    ];
    const pages = [
      { rows: [row(4), row(3)], nextBefore: cursors[0] },
      { rows: [row(2), row(1)], nextBefore: cursors[1] },
      { rows: [row(0)], nextBefore: null },
    ];
    let served = 0;
    const { client, asked } = clientFor(() => Response.json(pages[served++]));

    const rows: ActivityRow[] = [];
    let before: string | null = null;
    do {
      const page = await client.activity.log({ outcome: 'failed', limit: 2, before });
      rows.push(...page.rows);
      before = page.nextBefore;
    } while (before);

    expect(rows.map((r) => r.ts)).toEqual([row(4), row(3), row(2), row(1), row(0)].map((r) => r.ts));
    expect(asked.map((a) => a.url.searchParams.get('before'))).toEqual([null, ...cursors]);
    expect(asked.every((a) => a.url.searchParams.get('outcome') === 'failed')).toBe(true);
    expect(asked.every((a) => a.url.searchParams.get('limit') === '2')).toBe(true);
  });

  it('says which key or mode is missing', async () => {
    const cases = [
      { status: 401, error: 'unauthorized' },
      { status: 403, error: 'activity_key_required' },
      { status: 404, error: 'audit_mode_off' },
    ];
    for (const c of cases) {
      const { client } = clientFor(() => Response.json({ error: c.error }, { status: c.status }));
      for (const call of [client.activity.log({ user: USER }), client.activity.topUsers()]) {
        const error = await rejection(call);
        expect(error).toBeInstanceOf(ShardlensClientError);
        expect(error).toMatchObject({ status: c.status, code: c.error });
        expect((error as Error).message).not.toContain(USER);
      }
    }
  });
});

describe('activity.topUsers', () => {
  it('asks for the last 24 hours unless told 7 days', async () => {
    const top = { window: '24h', rows: [{ userId: USER, runs: 41 }] };
    const { client, asked } = clientFor(() => Response.json(top));
    await expect(client.activity.topUsers()).resolves.toEqual(top);
    await client.activity.topUsers('7d');
    expect(asked.map((a) => `${a.method} ${a.path}`)).toEqual([
      'GET /v1/audit/top-users?window=24h',
      'GET /v1/audit/top-users?window=7d',
    ]);
  });
});
