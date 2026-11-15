import { parseBatch } from '@shardlens/schema';
import type {
  APIChatInputApplicationCommandInteraction,
  APIInteraction,
  APIInteractionResponse,
  APIMessageComponentButtonInteraction,
} from 'discord-api-types/v10';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createShardlensHttp, type ShardlensHttp } from '../src/index.js';

const APP_ID = '1234567890123456789';
const GUILD_ID = '112233445566778899';
const USER_ID = '334455667788990011';
const SALT_B64 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
/** Shaped like an interaction token, and made up. */
const TOKEN = Buffer.from('interaction:1234567890123456789:made-up-for-these-tests').toString('base64url');

function currentMonth() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** A snowflake whose timestamp is `msAgo` milliseconds in the past. */
function snowflake(msAgo = 0) {
  return ((BigInt(Date.now() - msAgo) - 1_420_070_400_000n) << 22n).toString();
}

function fakeCollector(mode: 'privacy' | 'audit' = 'privacy') {
  const batches: { events: Record<string, unknown>[]; raw: string }[] = [];
  const violations: unknown[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/v1/config')) {
      return Response.json({
        v: 1,
        appId: APP_ID,
        mode,
        saltPeriod: 'month',
        salts: [{ period: currentMonth(), salt: SALT_B64 }],
        sampling: {},
        serverTime: new Date().toISOString(),
      });
    }
    const raw = await new Response(
      new Blob([init?.body as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('gzip')),
    ).text();
    const body = JSON.parse(raw) as { events: Record<string, unknown>[] };
    const parsed = parseBatch(body);
    if (!parsed.ok) violations.push(parsed.issues);
    else if (parsed.errors.length > 0) violations.push(parsed.errors);
    batches.push({ events: body.events, raw });
    return Response.json({ accepted: body.events.length, duplicates: 0, rejected: [] }, { status: 202 });
  });
  const events = (type?: string) => batches.flatMap((b) => b.events).filter((e) => !type || e.type === type);
  return {
    fetch: fetchImpl as unknown as typeof fetch,
    spy: fetchImpl,
    events,
    violations,
    raw: () => batches.map((b) => b.raw).join(),
  };
}

function slash(
  overrides: Partial<APIChatInputApplicationCommandInteraction> = {},
): APIChatInputApplicationCommandInteraction {
  return {
    id: snowflake(120),
    application_id: APP_ID,
    type: 2,
    token: TOKEN,
    version: 1,
    locale: 'en-GB',
    guild_locale: 'en-US',
    guild_id: GUILD_ID,
    guild: { id: GUILD_ID, locale: 'en-US', features: [] },
    channel: { id: '223344556677889900', type: 0 },
    channel_id: '223344556677889900',
    app_permissions: '0',
    entitlements: [],
    authorizing_integration_owners: { 0: GUILD_ID },
    context: 0,
    attachment_size_limit: 8_388_608,
    member: {
      user: { id: USER_ID, username: 'tester', discriminator: '0', global_name: 'Tester', avatar: null },
      roles: [],
      permissions: '8',
      joined_at: '2024-01-01T00:00:00.000Z',
      deaf: false,
      mute: false,
      flags: 0,
    },
    data: {
      id: '445566778899001122',
      name: 'ticket',
      type: 1,
      options: [
        {
          name: 'open',
          type: 1,
          options: [
            { name: 'category', type: 3, value: 'billing' },
            { name: 'reason', type: 3, value: `my card 4111-1111-1111-1111 and ${TOKEN}` },
          ],
        },
      ],
    },
    ...overrides,
  } as APIChatInputApplicationCommandInteraction;
}

class Ctx {
  promises: Promise<unknown>[] = [];
  waitUntil(promise: Promise<unknown>) {
    this.promises.push(promise);
  }
  settle() {
    return Promise.all(this.promises);
  }
}

const lenses: ShardlensHttp[] = [];
function setup(options: Parameters<typeof createShardlensHttp>[0] = {}, collectorMode?: 'privacy' | 'audit') {
  const collector = fakeCollector(collectorMode);
  const lens = createShardlensHttp({
    endpoint: 'https://collector.test',
    apiKey: 'slk_ingest_test',
    fetch: collector.fetch,
    logger: { warn: () => undefined },
    ...options,
  });
  lenses.push(lens);
  return { collector, lens };
}

afterEach(async () => {
  await Promise.all(lenses.splice(0).map((l) => l.shutdown({ timeoutMs: 50 })));
});

describe('createShardlensHttp', () => {
  it('does nothing until the first interaction (no timers or network at startup)', () => {
    const { collector } = setup();
    expect(collector.spy).not.toHaveBeenCalled();
  });

  it('records a slash command with its response time and sends it through waitUntil', async () => {
    const { collector, lens } = setup({ captureOptionValues: ['category'] });
    const handle = lens.wrapInteractionHandler(
      async (_i: APIInteraction, _env: unknown, _ctx: Ctx): Promise<APIInteractionResponse> => ({
        type: 4,
        data: { content: 'Ticket opened', flags: 64 },
      }),
    );
    const ctx = new Ctx();
    const response = await handle(slash(), {}, ctx);
    expect(response.type).toBe(4);
    await ctx.settle();

    const [event] = collector.events('interaction');
    expect(event).toMatchObject({
      kind: 'chat_input',
      command: 'ticket',
      sub: 'open',
      options: ['category', 'reason'],
      optionValues: { category: 'billing' },
      commandScope: 'global',
      context: 0,
      install: 'guild',
      guild: GUILD_ID,
      locale: 'en-GB',
      guildLocale: 'en-US',
      memberTier: 'admin',
      premium: false,
      outcome: 'ok',
      responseType: 4,
      deferred: false,
      ephemeral: true,
    });
    expect(event?.ackMs).toBeGreaterThanOrEqual(100);
    expect(event?.user).toMatch(new RegExp(`^h1:${currentMonth()}:[0-9a-f]{32}$`));
    expect(collector.violations).toEqual([]);
    const raw = collector.raw();
    // Markers that can't turn up by chance in an event ID, a hash or a timestamp.
    for (const secret of [USER_ID, TOKEN, 'tester', 'Tester', 'my card', '4111-1111']) {
      expect(raw).not.toContain(secret);
    }
  });

  it('identifies users by ID, username and avatar only, and only when both sides are in audit mode', async () => {
    const avatar = 'a_0123456789abcdef0123456789abcdef';
    const interaction = slash();
    const member = interaction.member as { user: { avatar: string | null } };
    member.user.avatar = avatar;
    const answer = async (_i: APIInteraction, _env: unknown, _ctx: Ctx): Promise<APIInteractionResponse> => ({
      type: 4,
      data: { content: 'ok' },
    });

    const identified = setup({ mode: 'audit' }, 'audit');
    const ctx = new Ctx();
    await identified.lens.wrapInteractionHandler(answer)(interaction, {}, ctx);
    await ctx.settle();
    expect(identified.collector.events('interaction')[0]?.actor).toEqual({
      userId: USER_ID,
      username: 'tester',
      avatar,
    });
    expect(identified.collector.raw()).not.toContain('Tester');

    const oneSided = setup({ mode: 'audit' }, 'privacy');
    const ctx2 = new Ctx();
    await oneSided.lens.wrapInteractionHandler(answer)(interaction, {}, ctx2);
    await ctx2.settle();
    expect(oneSided.collector.events('interaction')[0]).not.toHaveProperty('actor');
    expect(oneSided.collector.raw()).not.toContain(USER_ID);
  });

  it('marks answers that took longer than 3 seconds as timeouts', async () => {
    const { collector, lens } = setup();
    const handle = lens.wrapInteractionHandler(async (_i: APIInteraction, _c: Ctx) => ({ type: 5 }));
    const ctx = new Ctx();
    await handle(slash({ id: snowflake(4_000) }), ctx);
    await ctx.settle();
    expect(collector.events('interaction')[0]).toMatchObject({ outcome: 'timeout', deferred: true });
  });

  it('records handler errors by class and re-throws them unchanged', async () => {
    const { collector, lens } = setup();
    class TicketError extends Error {
      code = 50013;
    }
    const failure = new TicketError('Missing Permissions for user 334455667788990011');
    const handle = lens.wrapInteractionHandler(async (_i: APIInteraction, _c: Ctx) => {
      throw failure;
    });
    const ctx = new Ctx();
    await expect(handle(slash(), ctx)).rejects.toBe(failure);
    await ctx.settle();
    expect(collector.events('interaction')[0]).toMatchObject({
      outcome: 'error',
      errorClass: 'TicketError',
      errorCode: 50013,
    });
    expect(collector.raw()).not.toContain('Missing Permissions');
  });

  it('reads the response type from a Response object without consuming it', async () => {
    const { collector, lens } = setup();
    const handle = lens.wrapInteractionHandler(async (_i: APIInteraction, _c: Ctx) =>
      Response.json({ type: 9, data: { custom_id: 'feedback', title: 'Feedback', components: [] } }),
    );
    const ctx = new Ctx();
    const res = await handle(slash(), ctx);
    expect(await res.json()).toMatchObject({ type: 9 });
    await ctx.settle();
    expect(collector.events('interaction')[0]).toMatchObject({ outcome: 'ok', responseType: 9 });
  });

  it('attributes buttons to the command that created their message and normalises the custom ID', async () => {
    const { collector, lens } = setup();
    const button = {
      ...slash(),
      type: 3,
      data: { custom_id: `ticket:close:${GUILD_ID}`, component_type: 2 },
      message: { interaction: { id: snowflake(9_000), type: 2, name: 'ticket open', user: { id: USER_ID } } },
    } as unknown as APIMessageComponentButtonInteraction;
    const handle = lens.wrapInteractionHandler(async (_i: APIInteraction, _c: Ctx) => ({ type: 6 }));
    const ctx = new Ctx();
    await handle(button, ctx);
    await ctx.settle();
    expect(collector.events('interaction')[0]).toMatchObject({
      kind: 'button',
      customId: 'ticket:close:*',
      componentType: 2,
      sourceCommand: 'ticket',
      deferred: true,
    });
  });

  it('skips PING and opted-out users', async () => {
    const { collector, lens } = setup({ optedOut: [USER_ID] });
    const handle = lens.wrapInteractionHandler(async (_i: APIInteraction, _c: Ctx) => ({ type: 1 }));
    const ctx = new Ctx();
    await handle({ id: snowflake(), type: 1, application_id: APP_ID, token: TOKEN, version: 1 } as APIInteraction, ctx);
    await handle(slash(), ctx);
    await ctx.settle();
    await lens.flush();
    expect(collector.events('interaction')).toEqual([]);
  });

  it('stops calling an error listener once it is removed, even one added before the first event', () => {
    const { lens } = setup();
    const errors: string[] = [];
    const off = lens.on('error', (name) => errors.push(name));
    lens.track('Bad Name', {});
    expect(errors).toEqual(['track_invalid']);
    off();
    lens.track('Bad Name', {});
    expect(errors).toEqual(['track_invalid']);
  });

  it('records custom events and hashes their user', async () => {
    const { collector, lens } = setup();
    const ctx = new Ctx();
    lens.track('ticket_opened', { category: 'billing' }, { userId: USER_ID, guildId: GUILD_ID }, ctx);
    lens.track('Bad Name', {});
    await ctx.settle();
    const [event] = collector.events('custom');
    expect(event).toMatchObject({ name: 'ticket_opened', props: { category: 'billing' }, guild: GUILD_ID });
    expect(event?.user).toMatch(/^h1:/);
    expect(lens.stats().internalErrors.track_invalid).toBe(1);
  });
});
