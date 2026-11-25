import type { Client } from 'discord.js';
import type { MongoDBOptions } from './options.js';

/** What `@shardlens/collector/mongodb` hands back (the SDK has no build dependency on the collector). */
interface InBotCollector {
  fetch: typeof fetch;
  dashboardUrl: string | undefined;
  signInLink(): string | undefined;
  close(): Promise<void>;
}

export interface CollectorModule {
  startMongoCollector(
    options: MongoDBOptions & { appId: string; mode?: 'audit' | 'privacy' | undefined },
  ): Promise<InBotCollector>;
}

/** In a variable, so bundlers leave the optional package to be loaded at run time, and only by bots that ask. */
const COLLECTOR_MODULE = '@shardlens/collector/mongodb';

/**
 * The `mongodb` option: the collector on the bot's own MongoDB, in this process. Started once the bot is logged in
 * (its application ID names the app); until then, and while it starts, the SDK's requests wait here rather than time
 * out, so a slow login doesn't read as an outage.
 */
export class MongoDBCollector {
  readonly #client: Client;
  readonly #settings: MongoDBOptions;
  readonly #mode: 'audit' | 'privacy' | undefined;
  readonly #log: (message: string) => void;
  readonly #load: () => Promise<CollectorModule>;
  #started: Promise<InBotCollector> | undefined;
  #closed = false;
  #onClose: (() => void) | undefined;

  constructor(
    client: Client,
    settings: MongoDBOptions,
    mode: 'audit' | 'privacy' | undefined,
    log: (message: string) => void,
    load: () => Promise<CollectorModule> = () => import(COLLECTOR_MODULE) as Promise<CollectorModule>,
  ) {
    this.#load = load;
    this.#client = client;
    this.#settings = settings;
    this.#mode = mode;
    this.#log = log;
  }

  /** For the SDK's transport: every request goes to the collector in this process. */
  readonly fetch: typeof fetch = async (input, init) => {
    const collector = await this.#collector();
    return collector.fetch(input, init);
  };

  /** A one-time sign-in link to the dashboard, when this process serves it. */
  async signInLink(): Promise<string | undefined> {
    return (await this.#collector().catch(() => undefined))?.signInLink();
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#onClose?.();
    const started = this.#started;
    if (started) await (await started.catch(() => undefined))?.close();
  }

  #collector(): Promise<InBotCollector> {
    this.#started ??= this.#start();
    return this.#started;
  }

  async #start(): Promise<InBotCollector> {
    const appId = await this.#applicationId();
    let module: CollectorModule;
    try {
      module = await this.#load();
    } catch (error) {
      // Not installed, as opposed to installed and failing to load (which says why).
      const code = (error as { code?: unknown } | null)?.code;
      if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
        throw new Error('the mongodb option needs the collector: npm install @shardlens/collector');
      }
      throw new Error(`@shardlens/collector did not load: ${error instanceof Error ? error.message : String(error)}`);
    }
    const collector = await module.startMongoCollector({
      ...this.#settings,
      appId,
      ...(this.#mode === 'audit' ? { mode: 'audit' } : {}),
    });
    if (this.#closed) {
      await collector.close();
      throw new Error('Shardlens was shut down');
    }
    const link = collector.signInLink();
    if (collector.dashboardUrl && link) {
      this.#log(`Shardlens: dashboard at ${collector.dashboardUrl}. Sign in once with ${link} (valid 15 minutes).`);
    }
    return collector;
  }

  /** Known once the bot has logged in. */
  #applicationId(): Promise<string> {
    const known = this.#client.application?.id;
    if (known) return Promise.resolve(known);
    return new Promise((resolve, reject) => {
      const poll = setInterval(() => {
        const id = this.#client.application?.id;
        if (!id) return;
        clearInterval(poll);
        resolve(id);
      }, 250);
      poll.unref?.();
      this.#onClose = () => {
        clearInterval(poll);
        reject(new Error('Shardlens was shut down'));
      };
    });
  }
}
