import { ChatInputCommandInteraction, type Client, DiscordAPIError, Events, Guild, Message } from 'discord.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createShardlens, type Shardlens, type ShardlensOptions } from '../src/index.js';
import {
  APP_ID,
  AVATAR,
  CHANNEL_ID,
  contractViolations,
  currentMonth,
  fakeCollector,
  GUILD_ID,
  makeDiscordClient,
  rawGuild,
  rawSlashCommand,
  settle,
  snowflake,
  USER_ID,
} from './helpers.js';

const MEMBER_ID = '556677889900112233';
const CONTENT = '!ban <@556677889900112233> spamming my secret plans';

const lenses: Shardlens[] = [];
const clients: Client[] = [];

function setup(options: Partial<ShardlensOptions> = {}, collectorMode: 'privacy' | 'audit' = 'privacy') {
  const collector = fakeCollector(collectorMode);
  const { client } = makeDiscordClient(() => new Response(null, { status: 204 }));
  const lens = createShardlens(client, {
    endpoint: 'https://collector.test',
    apiKey: 'slk_ingest_test',
    fetch: collector.fetch,
    flushIntervalMs: 60_000,
    logger: { warn: () => undefined },
    ...options,
  });
  const everyone = { id: GUILD_ID, name: '@everyone', permissions: '0', position: 0, color: 0, hoist: false };
  const guild = Reflect.construct(Guild, [
    client,
    rawGuild({ roles: [{ ...everyone, managed: false, mentionable: false, flags: 0 }] }),
  ]) as Guild;
  client.guilds.cache.set(GUILD_ID, guild);
  lenses.push(lens);
  clients.push(client);
  return { collector, client, lens };
}

/** A guild message, with a tripwire on `content` so a test fails if the SDK ever reads it. */
function message(client: Client, authorId = MEMBER_ID, overrides: Record<string, unknown> = {}) {
  const author = { id: authorId, username: 'prefixer', discriminator: '0', global_name: 'Prefixer', avatar: AVATAR };
  const m = Reflect.construct(Message, [
    client,
    {
      id: snowflake(),
      channel_id: CHANNEL_ID,
      guild_id: GUILD_ID,
      author,
      member: { roles: [], joined_at: '2020-01-01T00:00:00.000Z', deaf: false, mute: false, flags: 0 },
      content: CONTENT,
      timestamp: new Date().toISOString(),
      edited_timestamp: null,
      tts: false,
      mention_everyone: false,
      mentions: [],
      mention_roles: [],
      attachments: [],
      embeds: [],
      pinned: false,
      type: 0,
      ...overrides,
    },
  ]) as Message;
  const reads = { content: 0 };
  Object.defineProperty(m, 'content', {
    get: () => {
      reads.content++;
      return CONTENT;
    },
  });
  return { message: m, reads };
}

afterEach(async () => {
  await Promise.all(lenses.splice(0).map((l) => l.shutdown({ timeoutMs: 10 })));
  for (const c of clients.splice(0)) c.removeAllListeners();
  expect(contractViolations.splice(0)).toEqual([]);
});

describe('message (prefix) commands', () => {
  it('records the command the bot matched, hashing the author and never reading the message', async () => {
    const { collector, client, lens } = setup();
    await settle();
    const { message: m, reads } = message(client);
    lens.trackMessageCommand(m, { command: 'ban', options: ['user', 'reason'], durationMs: 41.6 });
    await settle();
    await lens.flush();

    const [event] = collector.events('message_command');
    expect(event).toMatchObject({
      command: 'ban',
      options: ['user', 'reason'],
      guild: GUILD_ID,
      channelType: 0,
      guildLocale: 'en-GB',
      memberTier: 'member',
      outcome: 'ok',
      handlerMs: 42,
      ts: m.createdTimestamp,
    });
    expect(event?.user).toMatch(new RegExp(`^h1:${currentMonth()}:[0-9a-f]{32}$`));
    expect(event).not.toHaveProperty('actor');
    expect(reads.content).toBe(0);
    const raw = collector.raw();
    for (const secret of [MEMBER_ID, 'prefixer', 'secret plans', CHANNEL_ID]) expect(raw).not.toContain(secret);
  });

  it('wrapMessageCommand() counts an error the bot throws on purpose as a run, not a failure', async () => {
    class UserError extends Error {}
    const { collector, client, lens } = setup({ isExpectedError: (error) => error instanceof UserError });
    await settle();
    const run = lens.wrapMessageCommand('prefix', async (_m: Message) => {
      throw new UserError('prefixes are 1 to 3 characters');
    });
    await expect(run(message(client, USER_ID).message)).rejects.toThrow('prefixes are');
    await settle();
    await lens.flush();
    expect(collector.events('message_command')).toMatchObject([{ command: 'prefix', outcome: 'ok' }]);
    expect(collector.events('message_command')[0]?.errorClass).toBeUndefined();
  });

  it('wrapMessageCommand() records duration and the error class, and re-throws for the bot’s own handling', async () => {
    const { collector, client, lens } = setup();
    await settle();
    const { message: m } = message(client, USER_ID);
    const run = lens.wrapMessageCommand({ command: 'ticket', sub: 'close' }, async (_m: Message, _args: string[]) => {
      throw new DiscordAPIError({ code: 50013, message: 'Missing Permissions' }, 50013, 403, 'POST', '/x', {});
    });
    await expect(run(m, ['now'])).rejects.toThrow('Missing Permissions');
    const ok = lens.wrapMessageCommand('ping', (_m: Message) => 'pong');
    await expect(ok(message(client).message)).resolves.toBe('pong');
    await settle();
    await lens.flush();

    // By command, not by position: each event waits for its user hash, and two hashes can finish in either order.
    const events = collector.events('message_command');
    const failed = events.find((e) => e.command === 'ticket');
    const passed = events.find((e) => e.command === 'ping');
    expect(events).toHaveLength(2);
    expect(failed).toMatchObject({
      command: 'ticket',
      sub: 'close',
      outcome: 'error',
      errorClass: 'DiscordAPIError',
      errorCode: 50013,
      memberTier: 'admin', // the author owns the test server
    });
    expect(failed?.handlerMs).toEqual(expect.any(Number));
    expect(passed).toMatchObject({ command: 'ping', outcome: 'ok' });
    expect(collector.raw()).not.toContain('Missing Permissions');
  });

  it('records failures the bot caught itself', async () => {
    const { collector, client, lens } = setup();
    await settle();
    lens.trackMessageCommand(message(client).message, { command: 'balance', failed: true, durationMs: 5 });
    await settle();
    await lens.flush();
    expect(collector.events('message_command')[0]).toMatchObject({ command: 'balance', outcome: 'error' });
    expect(collector.events('message_command')[0]).not.toHaveProperty('errorClass');
  });

  it('keeps argument values only when allow-listed, and drops runs without a usable name', async () => {
    const { collector, client, lens } = setup({ captureOptionValues: ['duration'] });
    await settle();
    const m = message(client).message;
    lens.trackMessageCommand(m, { command: 'mute', optionValues: { duration: '10m', reason: 'private' } });
    lens.trackMessageCommand(m, { command: '' });
    lens.trackMessageCommand(m, { command: 'x'.repeat(33) });
    lens.trackMessageCommand(m, { command: 42 as unknown as string });
    await settle();
    await lens.flush();
    const events = collector.events('message_command');
    expect(events).toHaveLength(1);
    expect(events[0]?.optionValues).toEqual({ duration: '10m' });
    expect(lens.stats().internalErrors.message_command_invalid).toBe(3);
    expect(collector.raw()).not.toContain('private');
  });

  it('never keeps an argument value holding a Discord ID, such as a mention', async () => {
    const { collector, client, lens } = setup({ captureOptionValues: ['target', 'duration'] });
    await settle();
    lens.trackMessageCommand(message(client).message, {
      command: 'mute',
      optionValues: { target: '<@998877665544332211>', duration: '10m' },
    });
    await settle();
    await lens.flush();
    expect(collector.events('message_command')[0]?.optionValues).toEqual({ duration: '10m' });
    expect(collector.raw()).not.toContain('998877665544332211');
  });

  it('drops opted-out users and records a direct message as a DM', async () => {
    const { collector, client, lens } = setup();
    await settle();
    lens.optOut(MEMBER_ID);
    lens.trackMessageCommand(message(client).message, { command: 'ban' });
    const dm = message(client, USER_ID, {
      channel_id: snowflake(Date.now(), 5),
      guild_id: undefined,
      member: undefined,
    }).message;
    lens.trackMessageCommand(dm, { command: 'help' });
    await settle();
    await lens.flush();
    const events = collector.events('message_command');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ command: 'help', memberTier: 'dm' });
    expect(events[0]).not.toHaveProperty('guild');
  });

  it('sends who ran it only when both sides are in audit mode', async () => {
    const audit = setup({ mode: 'audit' }, 'audit');
    await settle();
    audit.lens.trackMessageCommand(message(audit.client).message, { command: 'warn' });
    await settle();
    await audit.lens.flush();
    expect(audit.collector.events('message_command')[0]?.actor).toEqual({
      userId: MEMBER_ID,
      username: 'prefixer',
      avatar: AVATAR,
    });

    const halfway = setup({ mode: 'audit' }, 'privacy');
    await settle();
    halfway.lens.trackMessageCommand(message(halfway.client).message, { command: 'warn' });
    await settle();
    await halfway.lens.flush();
    expect(halfway.collector.events('message_command')[0]).not.toHaveProperty('actor');
    expect(halfway.collector.raw()).not.toContain(MEMBER_ID);
  });

  it('never throws into the bot, even for something that is not a message', async () => {
    const { lens } = setup();
    await settle();
    expect(() => lens.trackMessageCommand({} as Message, { command: 'ban' })).not.toThrow();
    expect(() => lens.trackMessageCommand(null as unknown as Message, { command: 'ban' })).not.toThrow();
    expect(lens.stats().internalErrors.trackMessageCommand).toBe(2);
  });

  it('is off when interactions are disabled', async () => {
    const { collector, client, lens } = setup({ disable: ['interactions'] });
    await settle();
    lens.trackMessageCommand(message(client).message, { command: 'ban' });
    await settle();
    await lens.flush();
    expect(collector.events('message_command')).toHaveLength(0);
  });
});

describe('wrap() with a handler shared by slash and prefix commands', () => {
  it('runs the handler for a non-interaction first argument without recording or counting an error', async () => {
    const { collector, client, lens } = setup();
    await settle();
    const handler = lens.wrap(async (input: ChatInputCommandInteraction) => input.commandName);
    const prefixInput = { commandName: 'ban', user: { id: MEMBER_ID } } as unknown as ChatInputCommandInteraction;
    await expect(handler(prefixInput)).resolves.toBe('ban');

    const interaction = Reflect.construct(ChatInputCommandInteraction, [
      client,
      rawSlashCommand({ application_id: APP_ID }),
    ]) as ChatInputCommandInteraction;
    client.emit(Events.InteractionCreate, interaction);
    await handler(interaction);
    await interaction.reply({ content: 'done' });
    await settle();
    await lens.flush();
    expect(lens.stats().internalErrors).not.toHaveProperty('wrap');
    expect(collector.events('interaction')[0]?.handlerMs).toEqual(expect.any(Number));
  });
});
