import type {
  APIInteraction,
  APIInteractionResponse,
  APIMessageComponentButtonInteraction,
} from 'discord-api-types/v10';
import { afterEach, describe, expect, it } from 'vitest';
import { APP_ID, Ctx, GUILD_ID, month, setup, shutdownLenses, slash, snowflake, TOKEN, USER_ID } from './helpers.js';

afterEach(shutdownLenses);

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
    expect(event?.user).toMatch(new RegExp(`^h1:${month()}:[0-9a-f]{32}$`));
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

    const identified = setup({ mode: 'audit' }, { mode: 'audit' });
    const ctx = new Ctx();
    await identified.lens.wrapInteractionHandler(answer)(interaction, {}, ctx);
    await ctx.settle();
    expect(identified.collector.events('interaction')[0]?.actor).toEqual({
      userId: USER_ID,
      username: 'tester',
      avatar,
    });
    expect(identified.collector.raw()).not.toContain('Tester');

    const oneSided = setup({ mode: 'audit' }, { mode: 'privacy' });
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

  it('answers every interaction even when an option has the wrong type', async () => {
    for (const bad of [
      { environment: 1 as unknown as string },
      { exporters: { name: 'single', observe: () => undefined } as never },
      { optedOut: 5 as never, captureOptionValues: 7 as never },
    ]) {
      const { lens } = setup(bad);
      const failure = new Error('handler failed');
      const ok = lens.wrapInteractionHandler(async (_i: APIInteraction, _c: Ctx) => ({ type: 4 }));
      const broken = lens.wrapInteractionHandler(async (_i: APIInteraction, _c: Ctx) => {
        throw failure;
      });
      const ctx = new Ctx();
      await expect(ok(slash(), ctx)).resolves.toEqual({ type: 4 });
      await expect(broken(slash(), ctx)).rejects.toBe(failure);
      expect(() => lens.track('still_works')).not.toThrow();
      expect(() => lens.stats()).not.toThrow();
      await ctx.settle();
    }
  });

  it('never records user, channel or role options, nor a value holding a Discord ID, and cuts on whole characters', async () => {
    const { collector, lens } = setup({ captureOptionValues: ['target', 'room', 'note', 'reason', 'emoji'] });
    const handle = lens.wrapInteractionHandler(async (_i: APIInteraction, _c: Ctx) => ({ type: 4 }));
    const ctx = new Ctx();
    const interaction = slash();
    interaction.data.options = [
      { name: 'target', type: 6, value: '998877665544332211' },
      { name: 'room', type: 7, value: '223344556677889900' },
      { name: 'note', type: 3, value: 'see 998877665544332211' },
      { name: 'reason', type: 3, value: 'spam' },
      { name: 'emoji', type: 3, value: `${'x'.repeat(99)}😀` },
    ];
    await handle(interaction, ctx);
    await ctx.settle();
    expect(collector.events('interaction')[0]?.optionValues).toEqual({ reason: 'spam', emoji: 'x'.repeat(99) });
    expect(collector.raw()).not.toContain('998877665544332211');
  });

  it('accepts opted-out IDs as BigInts', async () => {
    const { collector, lens } = setup({ optedOut: [BigInt(USER_ID)] });
    expect(lens.isOptedOut(USER_ID)).toBe(true);
    const handle = lens.wrapInteractionHandler(async (_i: APIInteraction, _c: Ctx) => ({ type: 4 }));
    const ctx = new Ctx();
    await handle(slash(), ctx);
    await ctx.settle();
    expect(collector.events('interaction')).toHaveLength(0);
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
  it('records the custom ID of a modal a command opens, so the modal funnel can join it to the submission', async () => {
    const { collector, lens } = setup();
    const ctx = new Ctx();
    const command = lens.wrapInteractionHandler(
      async (_i: APIInteraction, _c: Ctx): Promise<APIInteractionResponse> => ({
        type: 9,
        data: { custom_id: `feedback:${USER_ID}`, title: 'Feedback', components: [] },
      }),
    );
    const button = lens.wrapInteractionHandler(
      async (_i: APIInteraction, _c: Ctx): Promise<APIInteractionResponse> => ({
        type: 9,
        data: { custom_id: 'report:modal', title: 'Report', components: [] },
      }),
    );
    await command(slash(), ctx);
    await button(
      { ...slash(), type: 3, data: { custom_id: 'report:open', component_type: 2 } } as unknown as APIInteraction,
      ctx,
    );
    await ctx.settle();
    const [opened, clicked] = collector.events('interaction');
    expect(opened).toMatchObject({ kind: 'chat_input', responseType: 9, customId: 'feedback:*' });
    // A component keeps its own ID.
    expect(clicked).toMatchObject({ kind: 'button', responseType: 9, customId: 'report:open' });
    expect(collector.raw()).not.toContain(USER_ID);
  });

  it('starts nothing for a PING, such as Discord checking the endpoint URL', async () => {
    const { collector, lens } = setup();
    const ctx = new Ctx();
    const handle = lens.wrapInteractionHandler(async (_i: APIInteraction, _c: Ctx) => ({ type: 1 }));
    await expect(
      handle({ id: snowflake(), type: 1, application_id: APP_ID, token: TOKEN, version: 1 } as APIInteraction, ctx),
    ).resolves.toEqual({ type: 1 });
    expect(ctx.promises).toEqual([]);
    expect(collector.spy).not.toHaveBeenCalled();
  });

  it('answers when an argument throws on reading waitUntil', async () => {
    const { lens } = setup();
    const hostile = {
      get waitUntil(): never {
        throw new Error('not available here');
      },
    };
    const handle = lens.wrapInteractionHandler(async (_i: APIInteraction, _c: unknown) => ({ type: 4 }));
    await expect(handle(slash(), hostile)).resolves.toEqual({ type: 4 });
  });

  it('leaves a Response that is not JSON alone, and still records the interaction', async () => {
    const { collector, lens } = setup();
    const ctx = new Ctx();
    const form = new FormData();
    form.set('payload_json', JSON.stringify({ type: 4, data: { content: 'file' } }));
    const handle = lens.wrapInteractionHandler(async (_i: APIInteraction, _c: Ctx) => new Response(form));
    const res = await handle(slash(), ctx);
    expect(res.bodyUsed).toBe(false);
    expect((await res.formData()).get('payload_json')).toContain('file');
    await ctx.settle();
    const [event] = collector.events('interaction');
    expect(event).toMatchObject({ outcome: 'ok' });
    expect(event).not.toHaveProperty('responseType');
  });

  it('keeps every event the wire format accepts when a payload has out-of-range values', async () => {
    const { collector, lens } = setup({ captureOptionValues: ['x'.repeat(33)] });
    const ctx = new Ctx();
    const handle = lens.wrapInteractionHandler(async (_i: APIInteraction, _c: Ctx) => ({
      type: 2 ** 60,
      data: { flags: 1.5 },
    }));
    const interaction = slash({
      // 20 digits but above 2^63: no collector column holds it.
      guild_id: '99999999999999999999',
      channel: { id: '223344556677889900', type: 0.5 } as never,
    });
    interaction.data.options = [{ name: 'x'.repeat(33), type: 3, value: 'kept out' }];
    await handle(interaction, ctx);
    await handle({ ...slash(), member: undefined, user: undefined } as unknown as APIInteraction, ctx);
    lens.track('weird_guild', {}, { userId: USER_ID, guildId: '99999999999999999999' }, ctx);
    await ctx.settle();
    expect(collector.violations).toEqual([]);
    const [event, ...others] = collector.events('interaction');
    // The interaction without a user is not sent: the collector would refuse it.
    expect(others).toEqual([]);
    expect(event).not.toHaveProperty('guild');
    expect(event).not.toHaveProperty('channelType');
    expect(event).not.toHaveProperty('responseType');
    expect(event).not.toHaveProperty('ephemeral');
    expect(event).not.toHaveProperty('optionValues');
    expect(collector.events('custom')[0]).not.toHaveProperty('guild');
  });

  it('hashes a custom event user given as a BigInt', async () => {
    const { collector, lens } = setup();
    const ctx = new Ctx();
    lens.track('ticket_opened', {}, { userId: BigInt(USER_ID) as unknown as string }, ctx);
    await ctx.settle();
    expect(collector.events('custom')[0]?.user).toMatch(/^h1:/);
    expect(collector.raw()).not.toContain(USER_ID);
  });
});
