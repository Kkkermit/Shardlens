import { ButtonInteraction, ChatInputCommandInteraction, type Client, Events, Guild } from 'discord.js';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { createPrivacyCommand, createShardlens, type Shardlens, type ShardlensOptions } from '../src/index.js';
import {
  contractViolations,
  fakeCollector,
  makeDiscordClient,
  rawButton,
  rawGuild,
  rawSlashCommand,
  settle,
  USER_ID,
} from './helpers.js';

const lenses: Shardlens[] = [];
const clients: Client[] = [];

function setup(options: Partial<ShardlensOptions> = {}, mode: 'privacy' | 'audit' = 'privacy') {
  const collector = fakeCollector(mode);
  const replies: unknown[] = [];
  const { client } = makeDiscordClient((url, init) => {
    if (url.includes('/callback')) replies.push(JSON.parse(String(init.body ?? '{}')));
    return new Response(null, { status: 204 });
  });
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
  return { collector, client, lens, replies };
}

afterEach(async () => {
  await Promise.all(lenses.splice(0).map((l) => l.shutdown({ timeoutMs: 10 })));
  for (const c of clients.splice(0)) c.removeAllListeners();
  expect(contractViolations.splice(0)).toEqual([]);
});

describe('forgetUser and opt-outs', () => {
  it('sends the user’s hashes, never the raw ID, in privacy mode', async () => {
    const { collector, lens } = setup();
    await settle();
    await expect(lens.forgetUser(USER_ID)).resolves.toEqual({ erased: 3 });
    expect(collector.erasures).toHaveLength(1);
    expect(collector.erasures[0]?.userHashes[0]).toMatch(/^h1:\d{4}-\d{2}:[0-9a-f]{32}$/);
    expect(JSON.stringify(collector.erasures)).not.toContain(USER_ID);
  });

  it('includes the raw ID only when both sides are in audit mode', async () => {
    const { collector, lens } = setup({ mode: 'audit' }, 'audit');
    await settle();
    await lens.forgetUser(USER_ID);
    expect(collector.erasures[0]?.userId).toBe(USER_ID);
  });

  it('starts with persisted opt-outs and reports changes so they can be saved', async () => {
    const changes: [string, boolean][] = [];
    const { lens } = setup({ optedOut: [USER_ID], onOptOutChange: (id, out) => changes.push([id, out]) });
    expect(lens.isOptedOut(USER_ID)).toBe(true);
    lens.optOut(USER_ID); // already opted out: no change event
    lens.optIn(USER_ID);
    lens.optOut(USER_ID);
    expect(changes).toEqual([
      [USER_ID, false],
      [USER_ID, true],
    ]);
  });
});

describe('/privacy command', () => {
  const privacyInteraction = (client: Client, sub: string) =>
    Reflect.construct(ChatInputCommandInteraction, [
      client,
      rawSlashCommand({
        data: { id: '445566778899001199', name: 'privacy', type: 1, options: [{ type: 1, name: sub }] },
      }),
    ]) as ChatInputCommandInteraction;

  it('defines info, optout, optin and erase, usable in servers, DMs and user installs', () => {
    const { lens } = setup();
    const cmd = createPrivacyCommand(lens);
    expect(cmd.data.name).toBe('privacy');
    expect(cmd.data.options?.map((o) => o.name)).toEqual(['info', 'optout', 'optin', 'erase']);
    expect(cmd.data.integration_types).toEqual([0, 1]);
  });

  it('opts the user out and replies ephemerally', async () => {
    const { client, lens, replies } = setup();
    await settle();
    const cmd = createPrivacyCommand(lens);
    expect(await cmd.handle(privacyInteraction(client, 'optout'))).toBe(true);
    expect(lens.isOptedOut(USER_ID)).toBe(true);
    expect(replies[0]).toMatchObject({ type: 4, data: { flags: 64 } });
  });

  it('erase deletes stored data and opts out', async () => {
    const { client, collector, lens } = setup();
    await settle();
    const erase = privacyInteraction(client, 'erase');
    client.emit(Events.InteractionCreate, erase);
    await createPrivacyCommand(lens).handle(erase);
    expect(lens.isOptedOut(USER_ID)).toBe(true);
    expect(collector.erasures).toHaveLength(1);

    // The erase command itself must not be recorded after the erasure it asked for.
    await settle();
    await lens.flush();
    expect(collector.events('interaction')).toEqual([]);
  });

  it('ignores other commands', async () => {
    const { client, lens } = setup();
    const other = Reflect.construct(ChatInputCommandInteraction, [
      client,
      rawSlashCommand(),
    ]) as ChatInputCommandInteraction;
    expect(await createPrivacyCommand(lens).handle(other)).toBe(false);
  });
});

describe('secrets never leave the process (security checklist 19.4)', () => {
  it('redacts 10,000 generated token-shaped strings from every free-text path', async () => {
    const logs: string[] = [];
    const { client, collector, lens } = setup({
      captureOptionValues: ['reason'],
      logger: { warn: (m) => logs.push(m), info: (m) => logs.push(m) },
    });
    await settle();
    const seg = (min: number, max: number) =>
      fc.string({
        unit: fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'),
        minLength: min,
        maxLength: max,
      });
    const tokens = fc.sample(
      fc.tuple(seg(23, 28), seg(6, 6), seg(27, 38)).map(([a, b, c]) => `${a}.${b}.${c}`),
      10_000,
    );
    const hmacs = tokens.map((t) => t.split('.')[2]!);

    tokens.forEach((token, i) => {
      if (i % 4 === 0) lens.track('leak_probe', { note: `token ${token}` });
    });
    for (const token of tokens.slice(0, 200)) {
      const slash = Reflect.construct(ChatInputCommandInteraction, [
        client,
        rawSlashCommand({
          data: {
            id: '445566778899001122',
            name: 'ticket',
            type: 1,
            options: [{ type: 1, name: 'open', options: [{ type: 3, name: 'reason', value: `see ${token}` }] }],
          },
        }),
      ]) as ChatInputCommandInteraction;
      client.emit(Events.InteractionCreate, slash);
      await slash.reply({ content: 'ok' });
      const button = Reflect.construct(ButtonInteraction, [
        client,
        rawButton(slash.id, { data: { custom_id: `x:${token}`, component_type: 2 } }),
      ]) as ButtonInteraction;
      client.emit(Events.InteractionCreate, button);
      await button.deferUpdate();
      await lens
        .wrap(async () => {
          throw new Error(`failed with ${token}`);
        })(slash)
        .catch(() => undefined);
    }
    for (const token of tokens.slice(200, 400)) {
      client.emit(Events.GuildCreate, Reflect.construct(Guild, [client, rawGuild({ name: `srv ${token}` })]) as Guild);
    }
    await settle(20);
    await lens.flush();
    const sent = collector.raw();
    expect(sent.length).toBeGreaterThan(0);
    const leaked = hmacs.filter((h) => sent.includes(h) || logs.some((l) => l.includes(h)));
    expect(leaked).toEqual([]);
  });
});
