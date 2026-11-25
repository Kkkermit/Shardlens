import type { Shardlens } from '@shardlens/discordjs';
import type { ErrorHandler } from '../core/error-handler.js';
import type { Logger } from '../core/logger.js';
import { fromInteraction } from './invocation.js';
import type { ComponentHandler, ComponentInteraction } from './types.js';

/** Routes buttons, menus and modals to the handler that owns the first segment of their custom ID. */
export class ComponentRouter {
  private readonly handlers = new Map<string, ComponentHandler>();

  constructor(
    private readonly errors: ErrorHandler,
    private readonly logger: Logger,
    private readonly lens: Shardlens,
  ) {}

  add(handler: ComponentHandler): this {
    if (this.handlers.has(handler.id)) throw new Error(`Component handler "${handler.id}" is registered twice`);
    this.handlers.set(handler.id, handler);
    return this;
  }

  async handle(interaction: ComponentInteraction): Promise<void> {
    const [namespace = ''] = interaction.customId.split(':');
    const handler = this.handlers.get(namespace);
    if (!handler) {
      this.logger.debug(`No handler for components in "${namespace}"`);
      return;
    }
    try {
      await this.lens.wrap((i: ComponentInteraction) => handler.run(i))(interaction);
    } catch (error) {
      await this.errors.handle(
        error,
        fromInteraction('component', interaction, { name: handler.id, description: `component ${handler.id}` }),
      );
    }
  }
}
