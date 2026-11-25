import { Client, GatewayIntentBits } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createShardlens } from '../src/index.js';
import { type CollectorModule, MongoDBCollector } from '../src/mongodb.js';
import type { MongoDBOptions } from '../src/options.js';
import { APP_ID, settle } from './helpers.js';

type Started = Parameters<CollectorModule['startMongoCollector']>[0];

/** A collector module that records how it was started and answers every request with its URL, as `fetch` would. */
function fakeModule(dashboardUrl?: string) {
  const starts: Started[] = [];
  const close = vi.fn(async () => undefined);
  const module: CollectorModule = {
    async startMongoCollector(options) {
      starts.push(options);
      return {
        fetch: async (input, init) => {
          init?.signal?.throwIfAborted();
          return Response.json({ url: String(input) });
        },
        dashboardUrl,
        signInLink: () => (dashboardUrl ? `${dashboardUrl}/auth/link/token` : undefined),
        close,
      };
    },
  };
  return { module, starts, close };
}

/** The one field the option reads: set once the bot has logged in. */
interface Bot {
  application: { id: string } | null;
}
const botClient = (): Bot => ({ application: null });
const asClient = (bot: Bot) => bot as unknown as Client;
const settings: MongoDBOptions = { uri: 'mongodb://localhost:27017/bot' };

describe('the mongodb option', () => {
  afterEach(() => vi.useRealTimers());

  it('starts the collector once the bot knows its application ID, and sends through it', async () => {
    const client = botClient();
    const fake = fakeModule();
    const collector = new MongoDBCollector(
      asClient(client),
      settings,
      undefined,
      () => undefined,
      async () => fake.module,
    );
    const answer = collector.fetch('http://localhost/v1/config');
    await settle();
    expect(fake.starts).toHaveLength(0);
    client.application = { id: APP_ID };
    expect(await (await answer).json()).toEqual({ url: 'http://localhost/v1/config' });
    await collector.fetch('http://localhost/v1/ingest', { method: 'POST' });
    expect(fake.starts).toEqual([{ uri: settings.uri, appId: APP_ID }]);
    await collector.close();
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it('passes audit mode on, and logs the dashboard sign-in link when this process serves it', async () => {
    const client = botClient();
    client.application = { id: APP_ID };
    const fake = fakeModule('http://localhost:8080');
    const log = vi.fn();
    const collector = new MongoDBCollector(
      asClient(client),
      { ...settings, auditKey: 'k', dashboard: { port: 8080 } },
      'audit',
      log,
      async () => fake.module,
    );
    await collector.fetch('http://localhost/v1/config');
    expect(fake.starts[0]).toMatchObject({ mode: 'audit', auditKey: 'k', dashboard: { port: 8080 } });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('http://localhost:8080/auth/link/token'));
    await collector.close();
  });

  it('never starts once shut down before the bot logged in', async () => {
    const client = botClient();
    const fake = fakeModule();
    const collector = new MongoDBCollector(
      asClient(client),
      settings,
      undefined,
      () => undefined,
      async () => fake.module,
    );
    const answer = collector.fetch('http://localhost/v1/config');
    await collector.close();
    await expect(answer).rejects.toThrow('shut down');
    client.application = { id: APP_ID };
    await settle();
    expect(fake.starts).toHaveLength(0);
  });

  it('starts again with the next request after a start failed, as when MongoDB was down when the bot started', async () => {
    const client = botClient();
    client.application = { id: APP_ID };
    const fake = fakeModule();
    let down = true;
    const module: CollectorModule = {
      startMongoCollector: async (options) => {
        if (down) throw new Error('connect ECONNREFUSED 127.0.0.1:27017');
        return fake.module.startMongoCollector(options);
      },
    };
    const collector = new MongoDBCollector(
      asClient(client),
      settings,
      undefined,
      () => undefined,
      async () => module,
    );
    await expect(collector.fetch('http://localhost/v1/config')).rejects.toThrow('ECONNREFUSED');
    down = false;
    expect((await collector.fetch('http://localhost/v1/config')).status).toBe(200);
    expect(fake.starts).toHaveLength(1);
    await collector.close();
  });

  it("doesn't count the wait for the start against a request's timeout, but still ends it on shutdown", async () => {
    const client = botClient();
    const fake = fakeModule();
    const collector = new MongoDBCollector(
      asClient(client),
      settings,
      undefined,
      () => undefined,
      async () => fake.module,
    );
    const timeout = new AbortController();
    const answer = collector.fetch('http://localhost/v1/config', { signal: timeout.signal });
    timeout.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    client.application = { id: APP_ID };
    expect((await answer).status).toBe(200);

    const shutdown = new AbortController();
    shutdown.abort();
    await expect(collector.fetch('http://localhost/v1/ingest', { signal: shutdown.signal })).rejects.toThrow();
    await collector.close();
  });

  it('says to install the collector when it is missing', async () => {
    const client = botClient();
    client.application = { id: APP_ID };
    const missing = Object.assign(new Error("Cannot find package '@shardlens/collector'"), {
      code: 'ERR_MODULE_NOT_FOUND',
    });
    const collector = new MongoDBCollector(
      asClient(client),
      settings,
      undefined,
      () => undefined,
      () => Promise.reject(missing),
    );
    await expect(collector.fetch('http://localhost/v1/config')).rejects.toThrow('npm install @shardlens/collector');
  });

  it('says why an installed collector failed to load, rather than to install it', async () => {
    const client = botClient();
    client.application = { id: APP_ID };
    const collector = new MongoDBCollector(
      asClient(client),
      settings,
      undefined,
      () => undefined,
      () => Promise.reject(new SyntaxError('Unexpected token')),
    );
    await expect(collector.fetch('http://localhost/v1/config')).rejects.toThrow(
      '@shardlens/collector did not load: Unexpected token',
    );
  });

  it('warns once, and only about the connection string, when it is missing or not MongoDB', () => {
    for (const mongodb of [undefined, '', 'postgres://localhost/db', { uri: 42 }]) {
      const warn = vi.fn();
      const lens = createShardlens(new Client({ intents: [GatewayIntentBits.Guilds] }), {
        mongodb,
        logger: { warn },
      } as never);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('mongodb must be a mongodb://'));
      expect(warn).toHaveBeenCalledOnce();
      void lens.shutdown({ timeoutMs: 0 });
    }
  });
});
