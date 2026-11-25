import type { Logger } from '@shardlens/core';
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

/** How long the transport lets a request take (its own timeout, in `@shardlens/core`). */
const REQUEST_TIMEOUT_MS = 10_000;

const isTimeout = (reason: unknown) => (reason as { name?: unknown } | null)?.name === 'TimeoutError';

/**
 * The `mongodb` option: the collector on the bot's own MongoDB, in this process. Started once the bot is logged in
 * (its application ID names the app); until then, and while it starts, the SDK's requests wait here, and the wait
 * doesn't count against their timeout, so a slow login or first start doesn't read as an outage. A start that fails
 * (MongoDB unreachable when the bot starts, say) is tried again with the next request.
 */
export class MongoDBCollector {
  readonly #client: Client;
  readonly #settings: MongoDBOptions;
  readonly #mode: 'audit' | 'privacy' | undefined;
  readonly #logger: Logger;
  readonly #load: () => Promise<CollectorModule>;
  readonly #closing = new AbortController();
  #started: Promise<InBotCollector> | undefined;
  #onClose: (() => void) | undefined;

  constructor(
    client: Client,
    settings: MongoDBOptions,
    mode: 'audit' | 'privacy' | undefined,
    logger: Logger,
    load: () => Promise<CollectorModule> = () => import(COLLECTOR_MODULE) as Promise<CollectorModule>,
  ) {
    this.#load = load;
    this.#client = client;
    this.#settings = settings;
    this.#mode = mode;
    this.#logger = logger;
  }

  /** For the SDK's transport: every request goes to the collector in this process. */
  readonly fetch: typeof fetch = async (input, init) => {
    const collector = await this.#collector();
    if (!init?.signal?.aborted || !isTimeout(init.signal.reason)) return collector.fetch(input, init);
    // Its timeout ran out while it waited for the collector to start, before the collector was asked: it gets its time
    // again from now on, and still ends with a shutdown.
    const signal = AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), this.#closing.signal]);
    return collector.fetch(input, { ...init, signal });
  };

  async close(): Promise<void> {
    this.#closing.abort();
    this.#onClose?.();
    const started = this.#started;
    if (started) await (await started.catch(() => undefined))?.close();
  }

  #collector(): Promise<InBotCollector> {
    if (this.#closing.signal.aborted) return Promise.reject(new Error('Shardlens was shut down'));
    this.#started ??= this.#start().catch((error: unknown) => {
      this.#started = undefined;
      throw error;
    });
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
    if (this.#closing.signal.aborted) {
      await collector.close();
      throw new Error('Shardlens was shut down');
    }
    const link = collector.signInLink();
    if (collector.dashboardUrl && link) {
      this.#announce(
        `Shardlens: dashboard at ${collector.dashboardUrl}. Sign in once with ${link} (valid 15 minutes).`,
      );
    }
    return collector;
  }

  /** At info, or as a warning by a logger without `info`: the owner can't sign in to the dashboard without the link. */
  #announce(message: string): void {
    try {
      if (this.#logger.info) this.#logger.info(message);
      else this.#logger.warn(message);
    } catch {
      // a broken logger must not break the SDK
    }
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
