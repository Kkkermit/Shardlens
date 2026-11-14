import {
  ButtonInteraction,
  ChatInputCommandInteraction,
  type Client,
  DiscordAPIError,
  Events,
  Guild,
  RESTEvents,
} from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createShardlens, type Shardlens, type ShardlensOptions } from '../src/index.js';
import {
  APP_ID,
  AVATAR,
  BOT_TOKEN,
  CHANNEL_ID,
  contractViolations,
  currentMonth,
  fakeCollector,
  GUILD_ID,
  makeDiscordClient,
  rawButton,
  rawGuild,
  rawSlashCommand,
  settle,
  USER_ID,
  undiciLikeResponse,
} from './helpers.js';

const lenses: Shardlens[] = [];
const clients: Client[] = [];

function setup(
  reply: Parameters<typeof makeDiscordClient>[0] = () => new Response(null, { status: 204 }),
  options: Partial<ShardlensOptions> = {},
  collectorMode: 'privacy' | 'audit' = 'privacy',
) {
  const collector = fakeCollector(collectorMode);
  const { client, calls } = makeDiscordClient(reply);
  const lens = createShardlens(client, {
    endpoint: 'https://collector.test',
    apiKey: 'slk_ingest_test',
    fetch: collector.fetch,
    flushIntervalMs: 60_000,
    logger: { warn: () => undefined },
    ...options,
  });
  lenses.push(lens);
  clients.push(client);
  return { collector, client, calls, lens };
}

function slash(client: Client, overrides: Record<string, unknown> = {}) {
  return Reflect.construct(ChatInputCommandInteraction, [
    client,
    rawSlashCommand(overrides),
  ]) as ChatInputCommandInteraction;
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(lenses.splice(0).map((l) => l.shutdown({ timeoutMs: 10 })));
  for (const c of clients.splice(0)) c.removeAllListeners();
  // Contract: everything the adapter sent must pass the collector's schema validation.
  expect(contractViolations.splice(0)).toEqual([]);
});

describe('exporters', () => {
  it('runs with exporters only: no collector, no hashing wait, no user in what exporters see', async () => {
    const seen: Record<string, unknown>[] = [];
    const { client, calls } = makeDiscordClient(() => new Response(null, { status: 204 }));
    const fetchSpy = vi.fn();
    const lens = createShardlens(client, {
      exporters: [{ name: 'test', observe: (e) => void seen.push(e as unknown as Record<string, unknown>) }],
      fetch: fetchSpy as unknown as typeof fetch,
      logger: { warn: () => undefined },
    });
    lenses.push(lens);
    clients.push(client);
    const interaction = slash(client);
    client.emit(Events.InteractionCreate, interaction);
    await interaction.reply({ content: 'Ticket opened' });
    await settle();
    const event = seen.find((e) => e.type === 'interaction');
    expect(event).toMatchObject({ kind: 'chat_input', command: 'ticket', outcome: 'ok', user: '' });
    expect(JSON.stringify(seen)).not.toContain(USER_ID);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(calls.length).toBeGreaterThan(0); // the reply itself still went to Discord
    expect(lens.stats().queueDepth).toBe(0);
  });
});

describe('interactions', () => {
  it('records a slash command with its first-response latency on one row, hashing the user', async () => {
    const { collector, client, lens } = setup(undefined, { captureOptionValues: ['category'] });
    await settle();
    const interaction = slash(client);
    client.emit(Events.InteractionCreate, interaction);
    await interaction.reply({ content: 'Ticket opened' });
    await settle();
    await lens.flush();

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
      ephemeral: false,
    });
    expect(event?.ackMs).toEqual(expect.any(Number));
    expect(event?.user).toMatch(new RegExp(`^h1:${currentMonth()}:[0-9a-f]{32}$`));
    // Nothing identifying or secret leaves the process.
    const raw = collector.raw();
    for (const secret of [USER_ID, interaction.token, BOT_TOKEN, 'tester', 'my card 4111', CHANNEL_ID]) {
      expect(raw).not.toContain(secret);
    }
  });

  it('records deferred and ephemeral first responses', async () => {
    const { collector, client, lens } = setup();
    await settle();
    const interaction = slash(client);
    client.emit(Events.InteractionCreate, interaction);
    await interaction.deferReply({ flags: 64 });
    await settle();
    await lens.flush();
    expect(collector.events('interaction')[0]).toMatchObject({ outcome: 'ok', deferred: true, ephemeral: true });
  });

  it('does not touch the shared body of undici-style responses, so discord.js still sees the API error (ADR 0009)', async () => {
    const { collector, client, lens } = setup(() =>
      undiciLikeResponse(404, { message: 'Unknown interaction', code: 10062 }),
    );
    await settle();
    const interaction = slash(client);
    client.emit(Events.InteractionCreate, interaction);
    const error = await interaction.reply({ content: 'too late' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DiscordAPIError);
    expect((error as DiscordAPIError).code).toBe(10062);
    await settle();
    await lens.flush();
    expect(collector.events('interaction')[0]).toMatchObject({ outcome: 'timeout', errorCode: 10062 });
  });

  it('reads the error code from genuine Response clones without stealing the bot’s copy', async () => {
    const { collector, client, lens } = setup(() =>
      Response.json({ message: 'Interaction has already been acknowledged.', code: 40060 }, { status: 400 }),
    );
    await settle();
    const interaction = slash(client);
    client.emit(Events.InteractionCreate, interaction);
    const error = await interaction.reply({ content: 'twice' }).catch((e: unknown) => e);
    expect((error as DiscordAPIError).code).toBe(40060);
    await settle();
    await lens.flush();
    expect(collector.events('interaction')[0]).toMatchObject({ outcome: 'error', errorCode: 40060 });
  });

  it('attributes component clicks to the command that created the message, with IDs stripped', async () => {
    const { collector, client, lens } = setup();
    await settle();
    const command = slash(client);
    client.emit(Events.InteractionCreate, command);
    await command.reply({ content: 'here is a button' });
    const button = Reflect.construct(ButtonInteraction, [client, rawButton(command.id)]) as ButtonInteraction;
    client.emit(Events.InteractionCreate, button);
    await button.deferUpdate();
    await settle();
    await lens.flush();
    const click = collector.events('interaction').find((e) => e.kind === 'button');
    expect(click).toMatchObject({ customId: 'ticket:close:*', sourceCommand: 'ticket', componentType: 2 });
  });

  it('wrap() records handler time and errors, and re-throws for the bot’s own handling', async () => {
    const { collector, client, lens } = setup();
    await settle();
    const interaction = slash(client);
    const handler = lens.wrap(async (i: ChatInputCommandInteraction) => {
      await i.reply({ content: 'working on it' });
      throw new RangeError('boom');
    });
    client.emit(Events.InteractionCreate, interaction);
    await expect(handler(interaction)).rejects.toThrow('boom');
    await settle();
    await lens.flush();
    const [event] = collector.events('interaction');
    expect(event).toMatchObject({ outcome: 'error', errorClass: 'RangeError' });
    expect(event?.handlerMs).toEqual(expect.any(Number));
    expect(collector.raw()).not.toContain('boom');
  });

  it('counts a reply that came after the deadline as a missed deadline, even when the handler then throws', async () => {
    const { collector, client, lens } = setup(() =>
      undiciLikeResponse(404, { message: 'Unknown interaction', code: 10062 }),
    );
    await settle();
    const interaction = slash(client);
    client.emit(Events.InteractionCreate, interaction);
    const handler = lens.wrap(async (i: ChatInputCommandInteraction) => {
      await i.reply({ content: 'too late' });
    });
    await expect(handler(interaction)).rejects.toBeInstanceOf(DiscordAPIError);
    await settle();
    await lens.flush();
    expect(collector.events('interaction')[0]).toMatchObject({
      outcome: 'timeout',
      errorCode: 10062,
      errorClass: 'DiscordAPIError',
    });
  });

  it('records the ID of a modal a command opened, so shown and submitted can be compared', async () => {
    const { collector, client, lens } = setup();
    await settle();
    const interaction = slash(client);
    client.emit(Events.InteractionCreate, interaction);
    await interaction.showModal({
      custom_id: 'feedback:998877665544332211',
      title: 'Feedback',
      components: [{ type: 1, components: [{ type: 4, custom_id: 'text', label: 'Text', style: 2 }] }],
    });
    await settle();
    await lens.flush();
    expect(collector.events('interaction')[0]).toMatchObject({
      kind: 'chat_input',
      responseType: 9,
      customId: 'feedback:*',
    });
    expect(collector.raw()).not.toContain('998877665544332211');
  });

  it('does not record the interaction a user opted out with', async () => {
    const { collector, client, lens } = setup();
    await settle();
    const interaction = slash(client);
    client.emit(Events.InteractionCreate, interaction);
    lens.optOut(USER_ID);
    await interaction.reply({ content: 'done' });
    await settle();
    await lens.flush();
    expect(collector.events('interaction')).toEqual([]);
  });

  it('wrap() works even when the bot’s listener runs before Shardlens sees the interaction', async () => {
    const { collector, client, lens } = setup();
    await settle();
    const interaction = slash(client);
    await lens.wrap(async (i: ChatInputCommandInteraction) => {
      await i.reply({ content: 'hi' });
    })(interaction);
    client.emit(Events.InteractionCreate, interaction); // late: must not create a second row
    await settle();
    await lens.flush();
    expect(collector.events('interaction')).toHaveLength(1);
    expect(collector.events('interaction')[0]).toMatchObject({ outcome: 'ok' });
  });

  it('sends interactions with no response after 10 seconds as no_response', async () => {
    const { collector, client, lens } = setup();
    await settle();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    client.emit(Events.InteractionCreate, slash(client));
    vi.advanceTimersByTime(10_001);
    vi.useRealTimers();
    await settle();
    await lens.flush();
    expect(collector.events('interaction')[0]).toMatchObject({ outcome: 'no_response' });
  });

  it('drops opted-out users in-process', async () => {
    const { collector, client, lens } = setup();
    await settle();
    lens.optOut(USER_ID);
    const interaction = slash(client);
    client.emit(Events.InteractionCreate, interaction);
    await interaction.reply({ content: 'hi' });
    await settle();
    await lens.flush();
    expect(collector.events('interaction')).toHaveLength(0);
  });

  it('sends who ran it only when both sides are in audit mode', async () => {
    const audit = setup(undefined, { mode: 'audit' }, 'audit');
    await settle();
    const i1 = slash(audit.client);
    audit.client.emit(Events.InteractionCreate, i1);
    await i1.reply({ content: 'hi' });
    await settle();
    await audit.lens.flush();
    // An identified user is an ID, a username and an avatar: the display name the test user has is not sent.
    expect(audit.collector.events('interaction')[0]?.actor).toEqual({
      userId: USER_ID,
      username: 'tester',
      avatar: AVATAR,
    });

    const idsOnly = setup(undefined, { mode: 'audit', auditIncludeProfile: false }, 'audit');
    await settle();
    const i3 = slash(idsOnly.client);
    idsOnly.client.emit(Events.InteractionCreate, i3);
    await i3.reply({ content: 'hi' });
    await settle();
    await idsOnly.lens.flush();
    expect(idsOnly.collector.events('interaction')[0]?.actor).toEqual({ userId: USER_ID });

    const halfway = setup(undefined, { mode: 'audit' }, 'privacy');
    await settle();
    const i2 = slash(halfway.client);
    halfway.client.emit(Events.InteractionCreate, i2);
    await i2.reply({ content: 'hi' });
    await settle();
    await halfway.lens.flush();
    expect(halfway.collector.events('interaction')[0]).not.toHaveProperty('actor');
    expect(halfway.collector.raw()).not.toContain(USER_ID);
  });

  it('never throws into the bot, even for malformed interactions', async () => {
    const { client, lens } = setup();
    await settle();
    expect(() => client.emit(Events.InteractionCreate, {} as never)).not.toThrow();
    expect(() => client.emit(Events.InteractionCreate, null as never)).not.toThrow();
    expect(lens.stats().internalErrors.interactionCreate).toBe(2);
  });
});

describe('REST', () => {
  it('aggregates calls by bucketed route and status with latency, never storing paths or headers', async () => {
    const { collector, client, lens } = setup((url) =>
      url.includes('/messages') ? Response.json({ id: '1' }) : new Response(null, { status: 204 }),
    );
    await settle();
    await client.rest.post(`/channels/${CHANNEL_ID}/messages`, { body: { content: 'secret message text' } });
    await client.rest.post(`/channels/${CHANNEL_ID}/messages`, { body: { content: 'again' } });
    await lens.flush();
    const [window] = collector.events('rest_window') as unknown as {
      rows: { method: string; route: string; status: number; count: number; latency: number[] }[];
    }[];
    expect(window?.rows).toEqual([
      expect.objectContaining({ method: 'POST', route: '/channels/:id/messages', status: 200, count: 2 }),
    ]);
    expect(window?.rows[0]?.latency.reduce((a, b) => a + b, 0)).toBe(2);
    const raw = collector.raw();
    for (const secret of [CHANNEL_ID, BOT_TOKEN, 'secret message text', 'authorization']) {
      expect(raw.toLowerCase()).not.toContain(secret.toLowerCase());
    }
  });

  it('writes an encoded @ in a route plainly, so one route is not stored under two names', async () => {
    const { collector, client, lens } = setup(() => new Response(null, { status: 204 }));
    await settle();
    // discord-api-types encodes route parameters, so "@me" reaches the REST client as "%40me".
    await client.rest.patch(`/guilds/${GUILD_ID}/members/%40me`, { body: { nick: 'lens' } });
    await lens.flush();
    const [window] = collector.events('rest_window') as unknown as { rows: { route: string }[] }[];
    expect(window?.rows.map((row) => row.route)).toEqual(['/guilds/:id/members/@me']);
  });

  it('counts 401, 403 and 429 toward the invalid-request budget, keeping shared 429s apart', async () => {
    let n = 0;
    const statuses = [403, 401];
    const { collector, client, lens } = setup(() => undiciLikeResponse(statuses[n++] ?? 403, { code: 50013 }));
    await settle();
    await client.rest.get(`/guilds/${GUILD_ID}`).catch(() => undefined);
    await client.rest.get(`/guilds/${GUILD_ID}`).catch(() => undefined);
    await lens.flush();
    const [window] = collector.events('rest_window');
    expect(window?.invalid).toEqual({ count401: 1, count403: 1, count429: 0, shared429: 0 });
  });

  it('records rate limits with a normalised route', async () => {
    const { collector, client, lens } = setup();
    await settle();
    client.rest.emit(RESTEvents.RateLimited, {
      global: false,
      scope: 'user',
      route: `/channels/${CHANNEL_ID}/messages`,
      method: 'post',
      limit: 5,
      retryAfter: 1200,
      sublimitTimeout: 0,
      timeToReset: 1200,
      hash: 'abc',
      majorParameter: CHANNEL_ID,
      url: `https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`,
    } as never);
    await lens.flush();
    expect(collector.events('rate_limit')[0]).toMatchObject({
      scope: 'user',
      route: '/channels/:id/messages',
      method: 'POST',
      retryAfter: 1200,
    });
    expect(collector.raw()).not.toContain(CHANNEL_ID);
  });

  it('restores makeRequest and removes every listener on shutdown', async () => {
    const { client, lens } = setup();
    const wrapped = client.rest.options.makeRequest;
    const before = client.listenerCount(Events.InteractionCreate);
    expect(before).toBe(1);
    await lens.shutdown({ timeoutMs: 10 });
    expect(client.rest.options.makeRequest).not.toBe(wrapped);
    expect(client.listenerCount(Events.InteractionCreate)).toBe(0);
    expect(client.rest.listenerCount(RESTEvents.Response)).toBe(0);
  });
});

describe('servers', () => {
  it('sends a full profile on join, and never the server owner', async () => {
    const { collector, client, lens } = setup();
    await settle();
    const guild = Reflect.construct(Guild, [client, rawGuild()]) as Guild;
    client.emit(Events.GuildCreate, guild);
    client.emit(Events.GuildDelete, guild);
    await lens.flush();
    const [join] = collector.events('guild_join');
    expect(join?.info).toMatchObject({
      guild: GUILD_ID,
      name: 'Test <script>alert(1)</script> server',
      memberCount: 42,
      premiumTier: 1,
      boosts: 3,
      features: ['COMMUNITY'],
      preferredLocale: 'en-GB',
      channelCounts: { '0': 1, '2': 1 },
    });
    expect(join?.info).not.toHaveProperty('ownerId');
    expect(collector.events('guild_leave')[0]).toMatchObject({ guild: GUILD_ID, detectedAtStartup: false });
    expect(collector.raw()).not.toContain(USER_ID);
  });
});

describe('server outages', () => {
  it('reports a server as available again only after it saw that server go down', async () => {
    const { collector, client, lens } = setup();
    await settle();
    const guild = Reflect.construct(Guild, [client, rawGuild()]) as Guild;
    // discord.js announces every server as available while a shard starts: that is not the end of an outage.
    client.emit(Events.GuildAvailable, guild);
    client.emit(Events.GuildUnavailable, guild);
    client.emit(Events.GuildAvailable, guild);
    client.emit(Events.GuildAvailable, guild);
    await lens.flush();
    expect(collector.events('guild_availability').map((e) => e.available)).toEqual([false, true]);
  });
});

describe('custom events', () => {
  it('stamps a custom event when track() is called, not when its user hash is ready', async () => {
    const { collector, lens } = setup();
    const called = Date.now();
    lens.track('early_event', {}, { userId: USER_ID });
    const later = vi.spyOn(Date, 'now').mockReturnValue(called + 30_000);
    await settle();
    later.mockRestore();
    await lens.flush();
    const [event] = collector.events('custom');
    expect(event?.ts).toBeGreaterThanOrEqual(called);
    expect(event?.ts).toBeLessThan(called + 1_000);
  });

  it('tracks valid events, hashes the user and drops invalid ones without throwing', async () => {
    const { collector, lens } = setup();
    await settle();
    lens.track('ticket_opened', { category: 'billing' }, { userId: USER_ID, guildId: GUILD_ID });
    lens.track('Bad Name', {});
    lens.track('too_big', { blob: 'x'.repeat(300) });
    await settle();
    await lens.flush();
    const events = collector.events('custom');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ name: 'ticket_opened', props: { category: 'billing' }, guild: GUILD_ID });
    expect(events[0]?.user).toMatch(/^h1:/);
    expect(lens.stats().internalErrors.track_invalid).toBe(2);
    expect(collector.raw()).not.toContain(USER_ID);
  });
});

describe('batch envelope', () => {
  it('identifies the app from the collector config and the SDK by name and version', async () => {
    const { collector, lens } = setup();
    await settle();
    lens.track('ping');
    await lens.flush();
    const body = JSON.parse(collector.batches[0]?.raw ?? '{}') as { app: { id: string }; sdk: { name: string } };
    expect(body.app.id).toBe(APP_ID);
    expect(body.sdk.name).toBe('@shardlens/discordjs');
  });
});
