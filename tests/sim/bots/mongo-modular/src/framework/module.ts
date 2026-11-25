import type { Client } from 'discord.js';
import type { AppConfig } from '../core/config.js';
import type { Container } from '../core/container.js';
import type { EventBus } from '../core/event-bus.js';
import type { Logger } from '../core/logger.js';
import { TOKENS } from '../core/tokens.js';
import type { CommandRegistry } from './command-registry.js';
import type { ComponentRouter } from './component-router.js';

export interface ModuleContext {
  readonly container: Container;
  readonly config: AppConfig;
  readonly client: Client;
  readonly commands: CommandRegistry;
  readonly components: ComponentRouter;
  readonly bus: EventBus;
  readonly logger: Logger;
}

/** A feature: its commands, components and event handlers, and the services behind them. */
export interface BotModule {
  readonly name: string;
  /** Registers the module's services. Runs for every module before any `setup()`. */
  register?(container: Container): void;
  setup(context: ModuleContext): void | Promise<void>;
}

export async function loadModules(container: Container, features: readonly BotModule[]): Promise<void> {
  const root = container.resolve(TOKENS.Logger);
  const logger = root.child('modules');

  for (const feature of features) feature.register?.(container);

  for (const feature of features) {
    await feature.setup({
      container,
      config: container.resolve(TOKENS.Config),
      client: container.resolve(TOKENS.Client),
      commands: container.resolve(TOKENS.Commands),
      components: container.resolve(TOKENS.Components),
      bus: container.resolve(TOKENS.EventBus),
      logger: root.child(feature.name),
    });
    logger.info(`Loaded module "${feature.name}"`);
  }
}
