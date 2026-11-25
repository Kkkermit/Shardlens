import type { Client } from 'discord.js';
import type { MongoConnection } from '../database/mongo.js';
import type { CommandRegistry } from '../framework/command-registry.js';
import type { ComponentRouter } from '../framework/component-router.js';
import type { PrefixResolver } from '../framework/types.js';
import type { AppConfig } from './config.js';
import { token } from './container.js';
import type { ErrorHandler } from './error-handler.js';
import type { EventBus } from './event-bus.js';
import type { Lifecycle } from './lifecycle.js';
import type { Logger } from './logger.js';

/** Core services. Feature modules keep their own tokens next to their code. */
export const TOKENS = {
  Config: token<AppConfig>('Config'),
  Logger: token<Logger>('Logger'),
  EventBus: token<EventBus>('EventBus'),
  Lifecycle: token<Lifecycle>('Lifecycle'),
  ErrorHandler: token<ErrorHandler>('ErrorHandler'),
  Mongo: token<MongoConnection>('MongoConnection'),
  Client: token<Client>('DiscordClient'),
  Commands: token<CommandRegistry>('CommandRegistry'),
  Components: token<ComponentRouter>('ComponentRouter'),
  PrefixResolver: token<PrefixResolver>('PrefixResolver'),
} as const;
