import { ChatInputCommandInteraction, type Client, Events, Guild, Message, RESTEvents } from 'discord.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createShardlens, type Shardlens } from '../src/index.js';
import {
  CHANNEL_ID,
  contractViolations,
  fakeCollector,
  GUILD_ID,
  makeDiscordClient,
  rawGuild,
  rawSlashCommand,
  settle,
  snowflake,
  USER_ID,
} from './helpers.js';

// Values from the bot and from discord.js that the wire format would refuse. One bad field must cost that field, not
// the whole event: the contract check after each test fails on any event the collector would reject.

const lenses: Shardlens[] = [];
const clients: Client[] = [];

function setup(reply: Parameters<typeof makeDiscordClient>[0] = () => new Response(null, { status: 204 })) {
  const collector = fakeCollector();
  const { client } = makeDiscordClient(reply);
  const lens = createShardlens(client, {
    endpoint: 'https://collector.test',
    apiKey: 'slk_ingest_test',
    fetch: collector.fetch,
    flushIntervalMs: 60_000,
    logger: { warn: () => undefined },
  });
  lenses.push(lens);
  clients.push(client);
  return { collector, client, lens };
}

afterEach(async () => {
  await Promise.all(lenses.splice(0).map((l) => l.shutdown({ timeoutMs: 10 })));
  for (const c of clients.splice(0)) c.removeAllListeners();
  expect(contractViolations.splice(0)).toEqual([]);
});

describe('values the wire format would refuse', () => {
  it('keeps rate limits and invalid-request warnings whose numbers are not finite', async () => {
    const { collector, client, lens } = setup();
    await settle();
    client.rest.emit(RESTEvents.RateLimited, {
      global: false,
      scope: 'user',
      route: '/channels/:id/messages',
      method: 'POST',
      limit: Number.NaN,
      retryAfter: Number.NaN,
      sublimitTimeout: Number.POSITIVE_INFINITY,
    } as never);
    client.rest.emit(RESTEvents.InvalidRequestWarning, { count: Number.NaN, remainingTime: Number.NaN } as never);
    await lens.flush();
    expect(collector.events('rate_limit')).toMatchObject([{ limit: 0, retryAfter: 0, sublimitTimeout: 0 }]);
    expect(collector.events('invalid_request_warning')).toMatchObject([{ count: 0, remainingTime: 0 }]);
  });

  it('keeps a custom event whose server ID is too long for a snowflake, without the server', async () => {
    const { collector, lens } = setup();
    await settle();
    lens.track('ticket_opened', {}, { guildId: '99999999999999999999' });
    lens.track('ticket_opened', {}, { guildId: GUILD_ID });
    await lens.flush();
    expect(collector.events('custom').map((e) => e.guild)).toEqual([undefined, GUILD_ID]);
  });

  it('clamps handler times the bot reports', async () => {
    const { collector, client, lens } = setup();
    await settle();
    const message = Reflect.construct(Message, [
      client,
      {
        id: snowflake(),
        channel_id: CHANNEL_ID,
        author: { id: USER_ID, username: 'u', discriminator: '0', avatar: null },
        content: '',
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
      },
    ]) as Message;
    lens.trackMessageCommand(message, { command: 'slow', durationMs: 1e300 });
    lens.trackMessageCommand(message, { command: 'fast', durationMs: -5 });
    const interaction = Reflect.construct(ChatInputCommandInteraction, [
      client,
      rawSlashCommand(),
    ]) as ChatInputCommandInteraction;
    client.emit(Events.InteractionCreate, interaction);
    lens.handlerFinished(interaction, { durationMs: 1e300 });
    await interaction.reply({ content: 'done' });
    await settle();
    await lens.flush();
    // By command, not by position: each event waits for its user hash, and two hashes can finish in either order.
    const handlerMs = Object.fromEntries(collector.events('message_command').map((e) => [e.command, e.handlerMs]));
    expect(handlerMs).toEqual({ slow: 2 ** 31 - 1, fast: 0 });
    expect(collector.events('interaction')).toMatchObject([{ handlerMs: 2 ** 31 - 1 }]);
  });

  it('records no boosts below zero, as discord.js can report', async () => {
    const { collector, client, lens } = setup();
    await settle();
    client.emit(Events.GuildCreate, Reflect.construct(Guild, [client, rawGuild({ premium_subscription_count: -1 })]));
    await lens.flush();
    expect(collector.events('guild_join')).toMatchObject([{ info: { boosts: 0 } }]);
  });

  it('leaves out an error code from Discord that is not a safe integer', async () => {
    const { collector, client, lens } = setup(() => Response.json({ code: 1e21 }, { status: 400 }));
    await settle();
    const interaction = Reflect.construct(ChatInputCommandInteraction, [
      client,
      rawSlashCommand(),
    ]) as ChatInputCommandInteraction;
    client.emit(Events.InteractionCreate, interaction);
    await interaction.reply({ content: 'x' }).catch(() => undefined);
    await settle();
    await lens.flush();
    const [event] = collector.events('interaction');
    expect(event).toMatchObject({ outcome: 'error' });
    expect(event).not.toHaveProperty('errorCode');
  });
});
