import { createShardlens } from '@shardlens/discordjs';
import { Client, GatewayIntentBits, Options, Partials } from 'discord.js';
import { loadConfig } from './core/config.js';
import { Container } from './core/container.js';
import { ErrorHandler } from './core/error-handler.js';
import { EventBus } from './core/event-bus.js';
import { Lifecycle } from './core/lifecycle.js';
import { Logger } from './core/logger.js';
import { TOKENS } from './core/tokens.js';
import { ensureIndexes, registerRepositories } from './database/index.js';
import { MongoConnection } from './database/mongo.js';
import { CommandRegistry } from './framework/command-registry.js';
import { ComponentRouter } from './framework/component-router.js';
import { bindGateway } from './framework/gateway.js';
import { cooldowns } from './framework/middleware/cooldown.js';
import { guildOnly } from './framework/middleware/guild-only.js';
import { permissions } from './framework/middleware/permissions.js';
import { loadModules } from './framework/module.js';
import { modules } from './modules/index.js';

function createClient(): Client {
  return new Client({
    // one process, Discord's recommended number of shards
    shards: 'auto',
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    // DMs arrive for channels discord.js hasn't cached
    partials: [Partials.Channel],
    allowedMentions: { parse: ['users'], repliedUser: false },
    makeCache: Options.cacheWithLimits({
      ...Options.DefaultMakeCacheSettings,
      MessageManager: 50,
      ReactionManager: 0,
      GuildInviteManager: 0,
    }),
    sweepers: {
      ...Options.DefaultSweeperSettings,
      messages: { interval: 3_600, lifetime: 1_800 },
    },
  });
}

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger(config.log.level);
  const container = new Container();

  container
    .value(TOKENS.Config, config)
    .value(TOKENS.Logger, logger)
    .register(TOKENS.EventBus, () => new EventBus(logger.child('bus')))
    .register(TOKENS.Lifecycle, () => new Lifecycle(logger.child('lifecycle')))
    .register(TOKENS.ErrorHandler, () => new ErrorHandler(logger.child('errors')))
    .register(TOKENS.Mongo, (c) => new MongoConnection(c.resolve(TOKENS.Config).mongo, logger.child('mongo')))
    .register(TOKENS.Client, createClient)
    .register(TOKENS.Shardlens, (c) =>
      createShardlens(c.resolve(TOKENS.Client), {
        mongodb: c.resolve(TOKENS.Config).mongo.uri,
        release: process.env.npm_package_version,
      }),
    )
    .register(
      TOKENS.Commands,
      (c) => new CommandRegistry(c.resolve(TOKENS.ErrorHandler), logger.child('commands'), c.resolve(TOKENS.Shardlens)),
    )
    .register(
      TOKENS.Components,
      (c) => new ComponentRouter(c.resolve(TOKENS.ErrorHandler), logger.child('components'), c.resolve(TOKENS.Shardlens)),
    );
  registerRepositories(container);

  const lifecycle = container.resolve(TOKENS.Lifecycle);
  lifecycle.listen();
  process.on('unhandledRejection', (reason) => logger.error('Unhandled promise rejection', { error: reason }));

  logger.info(`Starting nexus (${config.env})`);

  const mongo = container.resolve(TOKENS.Mongo);
  await mongo.connect();
  lifecycle.onShutdown('mongo', () => mongo.close());
  await ensureIndexes(container);

  container.resolve(TOKENS.Commands).use(guildOnly(), permissions(), cooldowns());
  await loadModules(container, modules);
  bindGateway(container);

  const client = container.resolve(TOKENS.Client);
  lifecycle.onShutdown('discord', () => client.destroy());
  // Hooks run in reverse order: registered after 'discord' so the last events are flushed before the client goes.
  const lens = container.resolve(TOKENS.Shardlens);
  lifecycle.onShutdown('shardlens', () => lens.shutdown());
  await client.login(config.discord.token);
}

bootstrap().catch((error: unknown) => {
  console.error('Fatal error during startup:', error instanceof Error ? error.stack : error);
  process.exit(1);
});
