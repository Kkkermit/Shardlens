import type { Logger } from './logger.js';

interface ShutdownHook {
  name: string;
  run(): unknown;
}

/** Runs shutdown hooks in reverse order of registration on SIGINT/SIGTERM, with a hard timeout. */
export class Lifecycle {
  private readonly hooks: ShutdownHook[] = [];
  private stopping = false;

  constructor(
    private readonly logger: Logger,
    private readonly timeoutMs = 10_000,
  ) {}

  onShutdown(name: string, run: () => unknown): void {
    this.hooks.push({ name, run });
  }

  listen(): void {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.on(signal, () => {
        if (this.stopping) {
          this.logger.warn(`Got ${signal} again, still shutting down`);
          return;
        }
        void this.shutdown(signal);
      });
    }
  }

  async shutdown(reason: string, exitCode = 0): Promise<never> {
    this.stopping = true;
    this.logger.info(`Shutting down (${reason})`);
    const force = setTimeout(() => {
      this.logger.error(`Shutdown took longer than ${this.timeoutMs}ms, exiting anyway`);
      process.exit(1);
    }, this.timeoutMs);
    force.unref();

    for (const hook of [...this.hooks].reverse()) {
      try {
        await hook.run();
        this.logger.debug(`Closed ${hook.name}`);
      } catch (error) {
        this.logger.error(`Shutdown hook "${hook.name}" failed`, { error });
      }
    }
    clearTimeout(force);
    this.logger.info('Bye');
    process.exit(exitCode);
  }
}
