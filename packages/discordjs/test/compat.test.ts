import { readdirSync, readFileSync } from 'node:fs';
import { ButtonInteraction, ChatInputCommandInteraction, type Client, Events } from 'discord.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createShardlens, type Shardlens } from '../src/index.js';
import { appInfo } from '../src/runtime.js';
import {
  contractViolations,
  fakeCollector,
  makeDiscordClient,
  rawButton,
  rawSlashCommand,
  settle,
  USER_ID,
} from './helpers.js';

// The oldest discord.js the peer range allows. Releases before it use @discordjs/rest 1, whose `response` events the
// SDK can't read, and miss some of the enums below.
const OLDEST = '14.12.0';
/** Every name the SDK imports from discord.js at runtime, checked to exist in discord.js 14.12.0. */
const IN_OLDEST = new Set([
  'ApplicationCommandOptionType',
  'ApplicationCommandType',
  'Events',
  'MessageFlags',
  'PermissionFlagsBits',
  'RESTEvents',
  'Routes',
  'version',
]);

const lenses: Shardlens[] = [];
const clients: Client[] = [];

function setup(options: Parameters<typeof createShardlens>[1] = {}) {
  const collector = fakeCollector();
  const { client } = makeDiscordClient(() => new Response(null, { status: 204 }));
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
  return { collector, client, lens };
}

afterEach(async () => {
  await Promise.all(lenses.splice(0).map((l) => l.shutdown({ timeoutMs: 10 })));
  for (const c of clients.splice(0)) c.removeAllListeners();
  expect(contractViolations.splice(0)).toEqual([]);
});

describe('older discord.js 14 releases', () => {
  it(`imports at runtime only what discord.js ${OLDEST} exports, so the ES module build loads there`, () => {
    const peer = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).peerDependencies;
    expect(peer['discord.js']).toMatch(new RegExp(`^\\^${OLDEST.replaceAll('.', '\\.')} `));
    const src = new URL('../src/', import.meta.url);
    const imported = new Set<string>();
    for (const file of readdirSync(src)) {
      const code = readFileSync(new URL(file, src), 'utf8');
      for (const [, names] of code.matchAll(/^import \{([^}]*)\} from 'discord\.js';/gm)) {
        for (const name of names?.split(',') ?? []) {
          const trimmed = name.trim();
          if (trimmed && !trimmed.startsWith('type ')) imported.add(trimmed.split(/\s+as\s+/)[0] as string);
        }
      }
    }
    expect(imported.size).toBeGreaterThan(0);
    expect([...imported].filter((name) => !IN_OLDEST.has(name))).toEqual([]);
  });

  it('records buttons where interactions have no isPrimaryEntryPointCommand (discord.js 14.18 and older)', async () => {
    const { collector, client, lens } = setup();
    await settle();
    const command = Reflect.construct(ChatInputCommandInteraction, [
      client,
      rawSlashCommand(),
    ]) as ChatInputCommandInteraction;
    const button = Reflect.construct(ButtonInteraction, [client, rawButton(command.id)]) as ButtonInteraction;
    Object.defineProperty(button, 'isPrimaryEntryPointCommand', { value: undefined });
    const errors: string[] = [];
    lens.on('error', (name) => errors.push(name));
    client.emit(Events.InteractionCreate, button);
    await button.deferUpdate();
    await settle();
    await lens.flush();
    expect(errors).toEqual([]);
    expect(collector.events('interaction')).toMatchObject([{ kind: 'button', outcome: 'ok' }]);
  });

  it('sends the app info where applications have no fetchSKUs (before discord.js 14.15)', async () => {
    const client = {
      application: { fetch: async () => ({ name: 'Old bot', owner: null }) },
      rest: { get: async () => ({ session_start_limit: { remaining: 990, total: 1000 } }) },
    };
    await expect(appInfo(client as unknown as Client<true>)).resolves.toMatchObject({
      type: 'app_info',
      name: 'Old bot',
      skus: [],
      sessionStartRemaining: 990,
    });
  });
});

describe('the bot’s own callbacks', () => {
  it('counts an async onOptOutChange that rejects, instead of leaving an unhandled rejection', async () => {
    const { lens } = setup({
      onOptOutChange: async () => {
        throw new Error('database down');
      },
    });
    const errors: string[] = [];
    lens.on('error', (name) => errors.push(name));
    lens.optOut(USER_ID);
    await settle();
    expect(lens.isOptedOut(USER_ID)).toBe(true);
    expect(errors).toEqual(['onOptOutChange']);
  });

  it('counts a rejecting thenable that is not a native promise', async () => {
    const thenable = {
      // biome-ignore lint/suspicious/noThenProperty: a database client's own promise type is what this stands for
      then: (_ok: unknown, fail: (e: unknown) => void) => fail(new Error('no')),
    };
    const { lens } = setup({ onOptOutChange: () => thenable as unknown as undefined });
    const errors: string[] = [];
    lens.on('error', (name) => errors.push(name));
    lens.optIn(USER_ID);
    lens.optOut(USER_ID);
    await settle();
    expect(errors).toEqual(['onOptOutChange']);
  });
});
